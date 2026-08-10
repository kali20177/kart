import { effectScope, reactive, ref, type UnwrapNestedRefs } from 'vue'
import type { AppSettings, DataMode, SerialDriver } from '@/types'
import { createSerialStore } from '@/stores/serial'
import { createMessagesStore } from '@/stores/messages'
import { createPauseStore } from '@/stores/pause'
import { createWaveformStore } from '@/stores/waveform'
import { createRecorderStore } from '@/stores/recorder'
import { createTransferStore } from '@/stores/transfer'
import { createTerminalStore } from '@/stores/terminal'
import { useSettingsStore } from '@/stores/settings'
import { createFreshSerialDriver } from '@/serial'

/** 创建会话时的可覆盖依赖（主要为测试注入 mock 驱动）。 */
export interface SessionOverrides {
  createDriver?: () => SerialDriver
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
  /** 全局设置（settings store 的同一 reactive proxy，跨会话共享） */
  settings: AppSettings
  /** 消息/发送框共用的数据显示模式（ASCII/HEX），会话级（初始取全局 defaultView） */
  viewMode: DataMode
  /** 发送框草稿文本（发送框随消息面板显示/隐藏，会话级保存） */
  composerText: string
  /** 销毁会话：停止 scope 内全部 watcher/computed，并触发各 store 的 onScopeDispose 清理（定时器/订阅/驱动）。 */
  dispose: () => void
}

/** 会话自增 id：跨 createSession 调用单调递增，保证每个会话有稳定唯一标识。 */
let _nextSessionId = 0

/**
 * 创建一个自包含的串口会话：serial/messages/pause/waveform/recorder/transfer/terminal
 * 互相通过注入的 deps 接线，共享同一个全局 settings（编码/主题/波特率等跨会话统一）。
 *
 * 创建顺序严格遵循依赖关系：pause → messages → (回填 clearMessages) → serial →
 * waveform → (回填 clearWaveform) → recorder → transfer → terminal。
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

    // 延迟绑定器：pause.clearAll 在调用时才解析到真实的 clear 回调
    let _clearMessages: () => void = () => {}
    let _clearWaveform: () => void = () => {}

    const pause = createPauseStore({
      clearMessages: () => _clearMessages(),
      clearWaveform: () => _clearWaveform(),
    })

    const messages = createMessagesStore({
      settings: s,
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

    const waveform = createWaveformStore({
      onData: (cb) => serial.onData(cb),
      settings: s,
      paused: pause.paused,
      pauseStartTime: pause.pauseStartTime,
      togglePause: () => pause.toggle(),
    })
    _clearWaveform = () => waveform.clear()

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

    return reactive({ serial, messages, pause, waveform, recorder, transfer, terminal, settings: s, viewMode: ref(s.defaultView), composerText: ref('') })
  })!

  const id = _nextSessionId++
  return { id, ...stores, dispose: () => scope.stop() }
}
