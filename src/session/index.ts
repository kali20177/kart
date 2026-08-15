import { effectScope, reactive, ref, watch, type UnwrapNestedRefs } from 'vue'
import type { AppSettings, ChecksumConfig, DataMode, IoTransport } from '@/types'
import type { DecoderConfig } from '@/decoders/types'
import { DEFAULT_DECODER_CONFIG } from '@/decoders'
import { storage } from '@/composables/useStorage'
import { defaultChecksumConfig } from '@/session/checksum'
import { createSerialStore } from '@/stores/serial'
import { createMessagesStore } from '@/stores/messages'
import { createPauseStore } from '@/stores/pause'
import { createWaveformStore } from '@/stores/waveform'
import { createRecorderStore } from '@/stores/recorder'
import { createTransferStore } from '@/stores/transfer'
import { createTerminalStore } from '@/stores/terminal'
import { createDashboardStore } from '@/stores/dashboard'
import type { DashboardWidget } from '@/stores/dashboard'
import { useSettingsStore } from '@/stores/settings'
import { createFreshSerialDriver } from '@/serial'

/** 创建会话时的可覆盖依赖（主要为测试注入 mock 驱动）。 */
export interface SessionOverrides {
  createDriver?: () => IoTransport
}

/**
 * 一个串口连接会话的全部状态。后续多 tab 时每个 tab 一个 Session 实例。
 * 各 store 经 reactive() 包装：顶层 ref 已解包（与 Pinia 用法一致，无 .value）。
 */
export interface Session {
  /** 会话稳定唯一标识（自增），用于 v-for :key，避免用数组下标导致关 tab 后实例错位 */
  id: number
  serial: UnwrapNestedRefs<ReturnType<typeof createSerialStore>>
  messages: UnwrapNestedRefs<ReturnType<typeof createMessagesStore>>
  pause: UnwrapNestedRefs<ReturnType<typeof createPauseStore>>
  waveform: UnwrapNestedRefs<ReturnType<typeof createWaveformStore>>
  recorder: UnwrapNestedRefs<ReturnType<typeof createRecorderStore>>
  transfer: UnwrapNestedRefs<ReturnType<typeof createTransferStore>>
  terminal: UnwrapNestedRefs<ReturnType<typeof createTerminalStore>>
  dashboard: UnwrapNestedRefs<ReturnType<typeof createDashboardStore>>
  /** 全局设置（settings store 的同一 reactive proxy，跨会话共享） */
  settings: AppSettings
  /** 消息/发送框共用的数据显示模式（ASCII/HEX），会话级（初始取全局 defaultView） */
  viewMode: DataMode
  /** 发送框草稿文本（发送框随消息面板显示/隐藏，会话级保存） */
  composerText: string
  /** 校验和配置（会话级、按端口持久化；发送/接收管线读取，ChecksumSettingsModal 编辑） */
  checksum: ChecksumConfig
  /** 帧解码配置（会话级、按端口持久化；消息管线读取，DecoderSettingsModal 编辑） */
  decoder: DecoderConfig
  /** 销毁会话：停止 scope 内全部 watcher/computed，并触发各 store 的 onScopeDispose 清理（定时器/订阅/驱动）。 */
  dispose: () => void
}

/** 会话自增 id：跨 createSession 调用单调递增，保证每个会话有稳定唯一标识。 */
let _nextSessionId = 0

/**
 * 创建一个自包含的串口会话：serial/messages/pause/waveform/recorder/transfer/terminal/dashboard
 * 互相通过注入的 deps 接线，共享同一个全局 settings（编码/主题/波特率等跨会话统一）。
 *
 * 创建顺序严格遵循依赖关系：pause → messages → (回填 clearMessages) → serial →
 * waveform → (回填 clearWaveform) → dashboard → recorder → transfer → terminal。
 *
 * 循环依赖（pause.clearAll 需要 messages.clear 与 waveform.clear）通过 closure
 * indirection 延迟绑定：先以空回调创建 pause，待目标 store 建好后回填真实引用。
 *
 * 整个创建过程包在 detached effectScope 中：scope.stop() 先执行各 store 的
 * onScopeDispose 清理（interval/timeout/subscription/driver），再停止 scope 内
 * 全部 watcher/computed。detached 使会话生命周期独立于调用方组件，需显式 dispose()。
 *
 * 返回的 session 用 reactive() 包装：store 顶层 ref（messages/shallowRef 等）被
 * 解包为直接可读写的属性，组件里与 Pinia 用法一致（无需 .value）。对 shallowRef
 * 的深层变更仍沿用 shallow 语义（替换才触发，与 store 内部行为一致）。
 */
export function createSession(overrides: SessionOverrides = {}): Session {
  const scope = effectScope(true)
  const createDriver = overrides.createDriver ?? (() => createFreshSerialDriver())

  const stores = scope.run(() => {
    const s = useSettingsStore().settings

    // 帧解码配置：会话级、按端口持久化。用 reactive 对象直传 messages store（与 settings 同例），
    // ConnectionBar 的帧解码弹窗（DecoderSettingsModal）经 session.decoder 直接编辑同一对象；
    // 端口确定后由下方 watcher 按端口加载/保存。
    const decoderCfg = reactive(structuredClone(DEFAULT_DECODER_CONFIG))

    // 校验和配置：会话级、按端口持久化（语义与 decoder 同构）。默认值以旧版全局设置播种
    // （settings store 七次迁移提取的 legacy-checksum 键），未配置端口回归该默认。
    const checksumCfg = reactive(defaultChecksumConfig())

    // 延迟绑定器：pause.clearAll 在调用时才解析到真实的 clear 回调
    let _clearMessages: () => void = () => {}
    let _clearWaveform: () => void = () => {}
    let _clearDashboard: () => void = () => {}

    const pause = createPauseStore({
      clearMessages: () => _clearMessages(),
      clearWaveform: () => _clearWaveform(),
      clearDashboard: () => _clearDashboard(),
    })

    const messages = createMessagesStore({
      settings: s,
      checksum: checksumCfg,
      decoder: decoderCfg,
      paused: pause.paused,
      pauseStartTime: pause.pauseStartTime,
      togglePause: () => pause.toggle(),
    })
    _clearMessages = () => messages.clear()

    const serial = createSerialStore({
      ingestRx: (bytes) => messages.ingestRx(bytes),
      addTx: (bytes, error) => messages.addTx(bytes, error),
      settings: s,
      createDriver,
    })

    // 解码器配置按端口持久化：切端口时加载该端口的配置，修改时写回当前端口。
    // 关键语义：连接前（端口未选）的配置编辑不写进 'default' 垃圾键，而是保留在内存，
    // 首个端口选中且无已存配置时沿用并落盘——避免「先选解码器再连接」被端口切换清掉。
    const DECODER_KEY = (port: string) => `decoder-config:${port}`
    let hasSelectedPort = false
    watch(
      serial.selectedPort,
      (port) => {
        if (!port) return
        // 旧版配置（v0）带 enabled 开关，新版以 id='' 表示不启用；读入时做迁移
        const stored = storage.get<Partial<DecoderConfig> & { enabled?: boolean } | null>(DECODER_KEY(port), null)
        const merged = {
          ...structuredClone(DEFAULT_DECODER_CONFIG),
          ...stored,
          options: { ...DEFAULT_DECODER_CONFIG.options, ...(stored?.options ?? {}) }
        }
        // 旧版 enabled=false 等价于 id=''（无解码器）；删除残留开关字段避免写回脏键
        if (stored?.enabled === false) merged.id = ''
        delete (merged as { enabled?: boolean }).enabled
        if (stored || hasSelectedPort) {
          // 该端口已有配置，或之前已选过端口 → 载入该端口配置（不同端口不同协议）
          Object.assign(decoderCfg, merged)
        } else {
          // 首个端口且无已存配置：沿用内存配置（可能连接前刚选了解码器），落盘一次
          storage.set(DECODER_KEY(port), decoderCfg)
        }
        hasSelectedPort = true
      },
      { immediate: true }
    )
    watch(
      decoderCfg,
      (cfg) => {
        const port = serial.selectedPort.value
        if (port) storage.set(DECODER_KEY(port), cfg)
      },
      // flush:'sync'：配置体量小，立即落盘——避免同 tick 内变更后紧接 dispose 丢最后一次写
      { deep: true, flush: 'sync' }
    )

    // 校验和配置按端口持久化（与 decoder-config 同构：切端口载入，变更写回）。
    // 首端口且无已存配置时沿用内存配置（含旧全局播种值）并落盘——升级后首次连接
    // 用户此前的全局校验设置不丢失，之后每个端口独立配置。
    const CHECKSUM_KEY = (port: string) => `checksum-config:${port}`
    let checksumHasSelectedPort = false
    watch(
      serial.selectedPort,
      (port) => {
        if (!port) return
        const stored = storage.get<Partial<ChecksumConfig> | null>(CHECKSUM_KEY(port), null)
        if (stored || checksumHasSelectedPort) {
          // 该端口已有配置，或之前已选过端口 → 载入该端口配置（不同端口不同校验方式）
          Object.assign(checksumCfg, { ...defaultChecksumConfig(), ...stored })
        } else {
          // 首个端口且无已存配置：沿用内存配置（含旧全局播种值），落盘一次
          storage.set(CHECKSUM_KEY(port), checksumCfg)
        }
        checksumHasSelectedPort = true
      },
      { immediate: true }
    )
    watch(
      checksumCfg,
      (cfg) => {
        const port = serial.selectedPort.value
        if (port) storage.set(CHECKSUM_KEY(port), cfg)
      },
      { deep: true, flush: 'sync' }
    )

    const waveform = createWaveformStore({
      onData: (cb) => serial.onData(cb),
      settings: s,
      paused: pause.paused,
      pauseStartTime: pause.pauseStartTime,
      togglePause: () => pause.toggle(),
    })
    _clearWaveform = () => waveform.clear()

    const dashboard = createDashboardStore({
      onDecode: (cb) => messages.onDecode(cb),
    })
    _clearDashboard = () => dashboard.clear()

    // 仪表盘 widget 配置按端口持久化（与 decoder-config 同构：切端口载入，变更写回）。
    // 首端口且无已存配置时沿用内存配置并落盘——连接前添加的 widget 不被端口切换清掉。
    const DASH_KEY = (port: string) => `dashboard-config:${port}`
    let dashHasSelectedPort = false
    watch(
      serial.selectedPort,
      (port) => {
        if (!port) return
        const stored = storage.get<DashboardWidget[] | null>(DASH_KEY(port), null)
        if (stored || dashHasSelectedPort) {
          dashboard.setWidgets(stored ?? [])
        } else {
          storage.set(DASH_KEY(port), dashboard.widgets.value)
        }
        dashHasSelectedPort = true
      },
      { immediate: true }
    )
    watch(
      dashboard.widgets,
      (list) => {
        const port = serial.selectedPort.value
        if (port) storage.set(DASH_KEY(port), list)
      },
      { deep: true, flush: 'sync' }
    )

    const recorder = createRecorderStore({
      onData: (cb) => serial.onData(cb),
      onTxData: (cb) => serial.onTxData(cb),
      connected: serial.connected,
      // 端口进文件名与主进程录制流键（并排多会话录制区分数据来源）
      port: serial.selectedPort,
      settings: s,
    })

    const transfer = createTransferStore({
      sendRaw: (bytes, record) => serial.sendRaw(bytes, record),
      onData: (cb) => serial.onData(cb),
      connected: serial.connected,
      addFileTransfer: (id, filename, size) => messages.addFileTransfer(id, filename, size),
    })

    const terminal = createTerminalStore({
      onData: (cb) => serial.onData(cb),
      sendRaw: (bytes, record) => serial.sendRaw(bytes, record),
      paused: pause.paused,
      pauseStartTime: pause.pauseStartTime,
      settings: s,
      // pty 数据源保证 UTF-8，忽略用户编码设置（串口 GBK 需求不适用于本地 shell）
      useUtf8: serial.driverType.value === 'pty',
    })

    return reactive({ serial, messages, pause, waveform, dashboard, recorder, transfer, terminal, settings: s, viewMode: ref(s.defaultView), composerText: ref(''), checksum: checksumCfg, decoder: decoderCfg })
  })!

  const id = _nextSessionId++
  // 整包 reactive()：让 session 自身就是响应式 proxy，不依赖调用方容器（ref 数组）
  // 深包装。此前返回 { id, ...stores } 普通对象——spread reactive 会解包顶层 ref，
  // 会话 2 经 dockview params 传递时拿到非响应式副本，composer 等 UI 不再随状态更新。
  return reactive({ id, ...stores, dispose: () => scope.stop() })
}
