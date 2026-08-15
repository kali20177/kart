import { defineStore } from 'pinia'
import { ref, reactive, computed, watch, onScopeDispose } from 'vue'
import type { MockScenarioId, EndpointInfo, PortOptions, SerialSignals, CustomBaudRate, ChecksumAlgorithm, IoTransport, TransportType } from '@/types'
import type { DriverType } from '@/serial'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { createDriverOfType, createSerialDriver, getDriverType, getUnsupportedReason, setDriverType } from '@/serial'
import { concatBytes, encodeText, lineEndingBytes } from '@/utils/encoding'
import { parseHexInput } from '@/utils/hex'
import { computeChecksum } from '@/utils/checksum'
import { isPresetBaud, isValidBaud, loadCustomBaudRates } from '@/utils/baud'
import { shouldReconnect } from '@/utils/reconnect'
import type { DataMode, LineEnding } from '@/types'
import { storage } from '@/composables/useStorage'
import { persistNow } from '@/utils/persist'
import { logger } from '@/utils/logger'
import { useMessagesStore } from './messages'
import { useSettingsStore } from './settings'

/** serial store 的外部依赖——RX/TX 帧写入委托给 messages，自动重连开关来自全局设置。
 *  ingestRx/addTx 由调用方注入；settings 是全局 settings store 的同一 reactive proxy。
 *  createDriver 提供驱动实例工厂：全局单例路径注入 createSerialDriver()（模块缓存），
 *  会话路径注入 createFreshSerialDriver()（每会话独立实例）。 */
export interface SerialDeps {
  ingestRx: (bytes: Uint8Array) => void
  addTx: (bytes: Uint8Array, error?: string) => void
  settings: { autoReconnect: boolean }
  createDriver: () => IoTransport
}

// 自动重连：固定 2s 间隔，不限次数；用户断开或关闭开关则停止。
const RECONNECT_INTERVAL_MS = 2000

/** Break 脉冲宽度：ST 等 MCU ISP 协议常用 250ms 拉低。 */
const BREAK_PULSE_MS = 250

const DEFAULT_OPTS: PortOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

/** TCP 默认端口（嵌入式上下文，Modbus TCP 等常用） */
const DEFAULT_TCP_PORT = 502

/** 端口号合法范围校验（1-65535 整数） */
function isValidTcpPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function createSerialStore(deps: SerialDeps) {
  let driver: IoTransport = deps.createDriver()
  const driverType = ref<DriverType>(getDriverType())
  const unsupportedReason = ref(getUnsupportedReason())

  const ports = ref<EndpointInfo[]>([])
  const selectedPort = ref<string | null>(null)
  const connected = ref(false)
  const options = reactive<PortOptions>({
    ...DEFAULT_OPTS,
    ...storage.get('portOptions', {})
  })
  // TCP 传输参数（host/port），持久化（kart:tcpOptions），供连接与自动重连使用。
  // port 允许 null：输入框清空时存 null（显示空），连接时校验并报「端口不能为空」。
  const tcpOptions = reactive<{ host: string; port: number | null }>({
    host: '',
    port: DEFAULT_TCP_PORT,
    ...storage.get('tcpOptions', {})
  })
  watch(
    tcpOptions,
    (val) => storage.set('tcpOptions', val),
    { deep: true }
  )
  /** 用户可见的传输类型：driverType==='tcp' 即 TCP，其余（serialport/webserial/mock/pty）都是串口后端 */
  const transportType = computed<TransportType>(() => (driverType.value === 'tcp' ? 'tcp' : 'serial'))
  const scenario = ref<MockScenarioId>('at-reply')
  const signals = ref<SerialSignals>({ dcd: false, cts: false, dsr: false, ri: false })
  // 输出控制线：记录「最后一次请求」的 DTR/RTS 电平（驱动无法读回输出线，UI 据此显示
  // toggle 状态）。会话生命周期内保持，断线重连后自动重放给驱动。
  const dtr = ref(false)
  const rts = ref(false)
  /** Break 脉冲进行中（UI 据此禁用 BRK 按钮防止连点） */
  const breakBusy = ref(false)
  const rxBytes = ref(0)
  const txBytes = ref(0)
  const sessionStartedAt = ref<number | null>(null)

  // ── 自动重连状态 ──
  // reconnecting=true 表示正在间隔等待中。曾意外掉线（非用户主动断开）且
  // 设置开启自动重连时启动；连接成功、用户手动断开、或关闭开关即清除。
  const reconnecting = ref(false)
  const reconnectAttempts = ref(0)
  // 下次重连的时间戳（Date.now()），UI 据此显示倒计时；null 表示未在重连。
  const reconnectNextAt = ref<number | null>(null)

  // 用户自定义波特率（可带标注，持久化）。预设档位不在此列、不可删除。
  // 读取时兼容旧版 number[] 格式（见 loadCustomBaudRates）。
  const customBaudRates = ref<CustomBaudRate[]>(
    loadCustomBaudRates(storage.get<unknown>('customBaudRates', []))
  )
  // 刚被用户删除的自定义波特率：若删的恰是当前选中值，ConnectionBar 的「当前值强制可选」
  // 逻辑会把它留在下拉候选里直到重启。记录之供 baudOptions 立即排除；重新输入/选择
  // 同值（重新加入列表）时经 addCustomBaudRate 解除。会话内存态，不持久化。
  const removedCustomBauds = ref<number[]>([])

  let unsubscribe: (() => void) | null = null
  let signalTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // 标记下一次 disconnect 的触发原因：true=用户主动断开，重连应跳过。
  // 跨函数传递一次性原因，避免 disconnect() 需要新加参数签名。
  let userInitiatedDisconnect = false

  // 额外的原始字节消费者（如波形 store）。与 messages store 的帧切分互不干扰：
  // 同一份字节流被两个独立消费者处理。订阅早于 connect() 也不会漏数据。
  const externalDataListeners = new Set<(bytes: Uint8Array) => void>()

  // TX 方向监听器（如 recorder store），在 driver.write() 成功后触发
  const txDataListeners = new Set<(bytes: Uint8Array) => void>()

  /** 订阅原始 RX 字节流（在帧切分之前）。返回取消订阅函数。 */
  function onData(cb: (bytes: Uint8Array) => void): () => void {
    externalDataListeners.add(cb)
    return () => externalDataListeners.delete(cb)
  }

  /** 通知驱动更新终端视口尺寸（pty 等支持 resize 的驱动；serialport/web serial 无此能力则 no-op）。 */
  function setSize(cols: number, rows: number): void {
    void driver.setSize?.(cols, rows)
  }

  /** 订阅原始 TX 字节流（driver.write 成功后）。返回取消订阅函数。 */
  function onTxData(cb: (bytes: Uint8Array) => void): () => void {
    txDataListeners.add(cb)
    return () => txDataListeners.delete(cb)
  }

  /** 串口参数概要，如 "115200 8N1" */
  const summary = computed(() => {
    const p = options.parity === 'none' ? 'N' : options.parity === 'even' ? 'E' : 'O'
    return `${options.baudRate} ${options.dataBits}${p}${options.stopBits}`
  })

  async function refreshPorts() {
    ports.value = await driver.listEndpoints()
    if (!selectedPort.value && ports.value.length > 0) {
      // 自动选中跳过被其他程序占用的端口（busy），避免默认连到不可用的口；
      // 全部占用时不选（null），留给用户在有可用端口时手动选择
      selectedPort.value = ports.value.find((p) => p.busy !== true)?.path ?? null
    }
  }

  /** 触发浏览器串口选择器（Web Serial 专属），选中后刷新端口列表 */
  async function requestPort(): Promise<string | null> {
    if (!driver.requestPort) return null
    const path = await driver.requestPort()
    if (path) {
      await refreshPorts()
      selectedPort.value = path
    }
    return path
  }

  async function connect() {
    // TCP 传输：连接前从 host/port 组端点（统一写入 selectedPort——显示/录制文件名/decoder-config 键共用）。
    // 无效端点抛错而非静默返回——ConnectionBar 的 toggle() 捕获后弹 toast，用户能感知原因。
    if (driverType.value === 'tcp') {
      const host = tcpOptions.host.trim()
      if (!host) throw new Error('TCP 主机不能为空')
      // IPv6 暂不支持：host 含 ':'（含 [::1] 方括号形式）明确拒绝，避免静默误解析成错误 host
      if (host.includes(':')) throw new Error('暂不支持 IPv6 地址，请使用 IPv4 或主机名')
      if (tcpOptions.port == null) throw new Error('TCP 端口不能为空')
      if (!isValidTcpPort(tcpOptions.port)) throw new Error(`TCP 端口无效: ${tcpOptions.port}（范围 1-65535）`)
      selectedPort.value = `${host}:${tcpOptions.port}`
    }
    if (connected.value || !selectedPort.value) return
    if (driver instanceof MockSerialSource) {
      driver.setScenario(scenario.value)
    }
    try {
      await driver.open(selectedPort.value, { ...options })
    } catch (e) {
      logger.error('serial', `connect failed: ${selectedPort.value} @ ${summary.value} driver=${driverType.value}`, e)
      throw e
    }
    logger.info('serial', `connected: ${selectedPort.value} @ ${summary.value} driver=${driverType.value}`)
    // 重连成功（reconnecting 为 true 表示这是自动重连路径）：清状态并通知 UI。
    const wasReconnecting = reconnecting.value
    if (wasReconnecting) {
      stopReconnectTimer()
      reconnecting.value = false
      reconnectNextAt.value = null
      reconnectAttempts.value = 0
    }
    rxBytes.value = 0
    txBytes.value = 0
    sessionStartedAt.value = Date.now()
    unsubscribe = driver.onData((bytes) => {
      rxBytes.value += bytes.length
      // 先 fan-out 给外部消费者（波形管线订阅原始字节），再入消息列表。
      // 顺序无关紧要：两者各自独立处理这份副本。
      if (externalDataListeners.size > 0) {
        for (const cb of externalDataListeners) cb(bytes)
      }
      deps.ingestRx(bytes)
    })
    connected.value = true
    if (wasReconnecting) {
      logger.info('serial', `auto-reconnect succeeded: ${selectedPort.value}`)
    }
    // 重放用户此前请求的输出线电平（如 ESP32/STM32 复位组合）。失败静默——
    // 硬件/虚拟串口可能不支持，下次 toggle 时 UI 会得到真实错误。非串口传输无此能力（可选链）。
    if (dtr.value || rts.value) {
      try {
        await driver.setSignals?.({ dtr: dtr.value, rts: rts.value })
      } catch (e) {
        logger.warn('serial', `re-assert DTR/RTS failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    signalTimer = setInterval(() => {
      if (!driver.isOpen) {
        // 驱动检测到物理断连，触发 full cleanup。
        // 非用户主动断开 → 标记原因以便 disconnect 启动自动重连。
        userInitiatedDisconnect = false
        logger.warn('serial', 'device lost (driver reported closed)')
        void disconnect()
        return
      }
      // 串口信号线（可选扩展）；TCP 无调制解调器线，保持默认 false
      const sig = driver.getSignals?.()
      if (sig) signals.value = sig
    }, 500)
  }

  /** 停止挂起的自动重连定时器（若有）。不重置 visible 状态。 */
  function stopReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /**
   * 启动一次自动重连（间隔后调用 connect）。
   * 判定集中在纯函数 shouldReconnect，便于单测。
   */
  function scheduleReconnect() {
    stopReconnectTimer()
    const decision = shouldReconnect(
      deps.settings.autoReconnect,
      connected.value,
      selectedPort.value
    )
    if (!decision.schedule) {
      reconnecting.value = false
      reconnectNextAt.value = null
      if (decision.reason === 'no-port') {
        logger.warn('serial', 'auto-reconnect aborted: no last port to reconnect to')
      }
      return
    }
    reconnecting.value = true
    reconnectAttempts.value += 1
    reconnectNextAt.value = Date.now() + RECONNECT_INTERVAL_MS
    logger.info('serial', `auto-reconnect scheduled (attempt ${reconnectAttempts.value}, next in ${RECONNECT_INTERVAL_MS}ms): ${selectedPort.value}`)
    reconnectTimer = setTimeout(() => {
      void attemptReconnect()
    }, RECONNECT_INTERVAL_MS)
  }

  /** 单次重连尝试：刷新端口确认设备在位后调用 connect()。失败/未归位则继续排程下一次。 */
  async function attemptReconnect() {
    reconnectTimer = null
    // 期间用户可能已关闭开关或手动重连
    if (!deps.settings.autoReconnect || connected.value || !selectedPort.value) {
      reconnecting.value = false
      reconnectNextAt.value = null
      return
    }
    try {
      await refreshPorts()
    } catch {
      // 列举失败不致命，继续尝试 open
    }
    // 设备重新枚举后仍未归位（仍被拔出）→ 跳过本次，排程下一次。
    // TCP 无枚举（listEndpoints 恒空），跳过在位检查直接尝试连接。
    if (driverType.value !== 'tcp' && !ports.value.some((p) => p.path === selectedPort.value)) {
      scheduleReconnect()
      return
    }
    try {
      // connect() 成功会清重连状态；失败抛错则进入 catch 继续排程
      await connect()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `auto-reconnect attempt failed: ${msg}`)
      if (!connected.value) scheduleReconnect()
    }
  }

  async function disconnect() {
    if (!connected.value) return
    const started = sessionStartedAt.value
    const reconnect = !userInitiatedDisconnect
    userInitiatedDisconnect = false
    unsubscribe?.()
    unsubscribe = null
    if (signalTimer) {
      clearInterval(signalTimer)
      signalTimer = null
    }
    await driver.close()
    connected.value = false
    sessionStartedAt.value = null
    signals.value = { dcd: false, cts: false, dsr: false, ri: false }
    const session = started
      ? ` (session ${Math.max(1, Math.round((Date.now() - started) / 1000))}s rx=${rxBytes.value}B tx=${txBytes.value}B)`
      : ''
    logger.info('serial', `disconnected${session}`)
    // 意外掉线（非用户主动）且开启自动重连 → 排程重连
    if (reconnect && deps.settings.autoReconnect) {
      scheduleReconnect()
    } else {
      // 用户主动断开或开关已关：确保无残留重连挂起
      stopReconnectTimer()
      reconnecting.value = false
      reconnectNextAt.value = null
      reconnectAttempts.value = 0
    }
  }

  /**
   * 用户主动断开（连接按钮、驱动切换等）：标记原因后调用 disconnect，
   * 确保 disconnect 不会反过来启动自动重连，并清掉挂起的重连。
   */
  async function userDisconnect() {
    userInitiatedDisconnect = true
    await disconnect()
  }

  function setScenario(id: MockScenarioId) {
    if (!import.meta.env.DEV) return
    if (!(driver instanceof MockSerialSource)) return
    scenario.value = id
    driver.setScenario(id)
  }

  /**
   * 切换驱动类型（含用户传输切换）。直接按目标类型构建驱动（不经环境解析单例，
   * 使生产环境可切 tcp）；DEV 下同步 setDriverType 更新模块解析结果，让新建会话
   * 继承当前切换（如 DEV 驱动切换工具切到 mock/pty 后新会话仍是 mock/pty）。
   */
  async function switchDriver(type: DriverType) {
    if (type === driverType.value) return
    if (connected.value) await userDisconnect()
    // 切换驱动期间停止任何挂起的自动重连（端口/驱动都已变化）
    stopReconnectTimer()
    reconnecting.value = false
    reconnectNextAt.value = null
    reconnectAttempts.value = 0
    const prevDriver = driver
    // DEV 下更新模块解析状态（生产 no-op）。仅串口后端持久化——tcp 是用户传输态，
    // 写进模块级解析会让 getDriverType() 返回 'tcp'，setTransport('serial') 据此解析
    // 串口后端时命中早退，DEV 下切不回串口（round-trip 卡死）。
    if (type !== 'tcp') setDriverType(type)
    driver = createDriverOfType(type)
    driverType.value = type
    unsupportedReason.value = type === 'unsupported' ? getUnsupportedReason() : null
    // 销毁旧驱动（持有端口/socket 句柄的传输实现 destroy；无资源者可选链跳过）
    prevDriver.destroy?.()
    // re-seed scenario for mock
    if (driver instanceof MockSerialSource) {
      driver.setScenario(scenario.value)
    }
    selectedPort.value = null
    await refreshPorts()
  }

  /** 用户切换传输类型（串口/TCP）。回串口 = 环境解析的串口后端（serialport/webserial/mock/pty）。 */
  async function setTransport(t: TransportType) {
    if (t === transportType.value) return
    await switchDriver(t === 'tcp' ? 'tcp' : getDriverType())
  }

  /** 新增自定义波特率（非法值/预设档位/已存在项会被忽略） */
  function addCustomBaudRate(baud: number) {
    if (!isValidBaud(baud)) return
    if (isPresetBaud(baud)) return
    if (customBaudRates.value.some((c) => c.baud === baud)) return
    customBaudRates.value = [...customBaudRates.value, { baud }].sort((a, b) => a.baud - b.baud)
    persistNow('customBaudRates', customBaudRates.value)
    // 重新加入列表 → 解除「删除后隐藏」状态（见 removedCustomBauds）
    removedCustomBauds.value = removedCustomBauds.value.filter((b) => b !== baud)
  }

  /** 删除自定义波特率（预设档位不在 customBaudRates 中，天然不可删）。
   *  若删的是当前选中值，记录之，让下拉候选立即排除（否则「当前值强制可选」会把它
   *  留在列表里直到重启）。当前选中值本身不变，触发框仍显示该值。 */
  function removeCustomBaudRate(baud: number) {
    customBaudRates.value = customBaudRates.value.filter((c) => c.baud !== baud)
    persistNow('customBaudRates', customBaudRates.value)
    if (options.baudRate === baud && !removedCustomBauds.value.includes(baud)) {
      removedCustomBauds.value.push(baud)
    }
  }

  /** 更新自定义波特率的标注（空串清除标注） */
  function updateCustomBaudNote(baud: number, note: string) {
    const trimmed = note.trim()
    customBaudRates.value = customBaudRates.value.map((c) =>
      c.baud === baud ? { ...c, note: trimmed || undefined } : c
    )
    persistNow('customBaudRates', customBaudRates.value)
  }

  /**
   * 写失败统一处理：记录 TX 气泡（record=false 时不建）；若驱动已报告物理断连
   * （500ms 轮询尚未触发），立即走断连/自动重连——UI 即刻恢复，而不是让用户在
   * 「已连接」下反复看到失败气泡。
   */
  function noteWriteFailure(bytes: Uint8Array, msg: string, record: boolean): void {
    if (record) deps.addTx(bytes, msg)
    if (!driver.isOpen) {
      userInitiatedDisconnect = false
      void disconnect()
    }
  }

  /**
   * 发送 —— 把文本/hex 按当前模式转字节，追加行尾，写入驱动并记录 TX 气泡。
   * 返回是否成功（hex 解析失败时返回错误信息）。
   */
  async function send(
    payload: string,
    mode: DataMode,
    ending: LineEnding,
    encoding: 'utf-8' | 'ascii' | 'gbk',
    checksum: ChecksumAlgorithm = 'none'
  ): Promise<{ ok: boolean; error?: string }> {
    if (!connected.value) return { ok: false, error: '未连接' }

    let body: Uint8Array
    if (mode === 'hex') {
      const r = parseHexInput(payload)
      if (!r.ok) return { ok: false, error: r.error }
      body = r.bytes
    } else {
      body = encodeText(payload, encoding)
    }

    // 校验和计算（行尾之前）
    if (checksum !== 'none') {
      body = concatBytes(body, computeChecksum(body, checksum))
    }

    const bytes = concatBytes(body, lineEndingBytes(ending))

    try {
      await driver.write(bytes)
      txBytes.value += bytes.length
      if (txDataListeners.size > 0) {
        for (const cb of txDataListeners) cb(bytes)
      }
      deps.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `write failed: ${msg}`)
      noteWriteFailure(bytes, msg, true)
      return { ok: false, error: msg }
    }
  }

  /**
   * 原始字节下发（文件引擎用）。不追加行尾、不强制建气泡。
   * record=true 时建一条 TX 帧气泡（调试用）。
   */
  async function sendRaw(bytes: Uint8Array, record = true): Promise<{ ok: boolean; error?: string }> {
    if (!connected.value) return { ok: false, error: '未连接' }
    try {
      await driver.write(bytes)
      txBytes.value += bytes.length
      if (txDataListeners.size > 0) {
        for (const cb of txDataListeners) cb(bytes)
      }
      if (record) deps.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `write failed: ${msg}`)
      noteWriteFailure(bytes, msg, record)
      return { ok: false, error: msg }
    }
  }

  /** 直接重发原始字节（气泡"重发"按钮用，bytes 已含行尾） */
  async function resend(bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
    if (!connected.value) return { ok: false, error: '未连接' }
    try {
      await driver.write(bytes)
      txBytes.value += bytes.length
      if (txDataListeners.size > 0) {
        for (const cb of txDataListeners) cb(bytes)
      }
      deps.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `write failed: ${msg}`)
      noteWriteFailure(bytes, msg, true)
      return { ok: false, error: msg }
    }
  }

  /**
   * 请求 DTR 电平。未连接时仅记录意图（UI toggle 状态），连接时下发驱动；
   * 驱动调用失败则回滚 UI 状态（显示不应与实际不符）。
   */
  async function setDtr(on: boolean): Promise<void> {
    const prev = dtr.value
    dtr.value = on
    if (!connected.value) return
    try {
      await driver.setSignals?.({ dtr: on })
    } catch (e) {
      dtr.value = prev
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `set DTR=${on} failed: ${msg}`)
      throw e
    }
  }

  /** 请求 RTS 电平。语义同 setDtr。 */
  async function setRts(on: boolean): Promise<void> {
    const prev = rts.value
    rts.value = on
    if (!connected.value) return
    try {
      await driver.setSignals?.({ rts: on })
    } catch (e) {
      rts.value = prev
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `set RTS=${on} failed: ${msg}`)
      throw e
    }
  }

  /** 发送一次 Break 脉冲（TX 拉低 250ms 后释放）。脉冲期间 breakBusy 阻止重复触发。 */
  async function pulseBreak(): Promise<void> {
    if (!connected.value || breakBusy.value) return
    breakBusy.value = true
    try {
      await driver.setBreak?.(true)
      await new Promise((r) => setTimeout(r, BREAK_PULSE_MS))
      await driver.setBreak?.(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn('serial', `send break failed: ${msg}`)
      throw e
    } finally {
      breakBusy.value = false
    }
  }

  /** 恢复串口相关默认配置（端口参数 + 自定义波特率），不影响连接/会话状态 */
  function reset() {
    Object.assign(options, DEFAULT_OPTS)
    customBaudRates.value = []
    removedCustomBauds.value = []
    persistNow('customBaudRates', [])
  }

  // 用户在重连等待期间关闭「自动重连」开关 → 停止挂起重连、恢复未连接状态。
  watch(
    () => deps.settings.autoReconnect,
    (on) => {
      if (!on) {
        stopReconnectTimer()
        reconnecting.value = false
        reconnectNextAt.value = null
        reconnectAttempts.value = 0
      }
    }
  )

  // 会话销毁清理：停止定时器、退订驱动回调、关闭并销毁驱动。
  // 只触碰非响应式资源（timer/unsubscribe/driver），不动 ref——响应式状态随 scope 销毁 GC。
  onScopeDispose(() => {
    stopReconnectTimer()
    unsubscribe?.()
    if (signalTimer) {
      clearInterval(signalTimer)
      signalTimer = null
    }
    if (driver.isOpen) {
      driver.close().catch(() => {})
    }
    driver.destroy?.()
  })

  return {
    ports,
    selectedPort,
    connected,
    options,
    tcpOptions,
    transportType,
    scenario,
    signals,
    dtr,
    rts,
    breakBusy,
    rxBytes,
    txBytes,
    sessionStartedAt,
    customBaudRates,
    removedCustomBauds,
    summary,
    driverType,
    unsupportedReason,
    reconnecting,
    reconnectAttempts,
    reconnectNextAt,
    refreshPorts,
    requestPort,
    connect,
    disconnect,
    userDisconnect,
    setDtr,
    setRts,
    pulseBreak,
    setScenario,
    switchDriver,
    setTransport,
    addCustomBaudRate,
    removeCustomBaudRate,
    updateCustomBaudNote,
    send,
    sendRaw,
    resend,
    onTxData,
    onData,
    setSize,
    reset
  }
}

/** 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。 */
export const useSerialStore = defineStore('serial', () => {
  const m = useMessagesStore()
  const s = useSettingsStore()
  return createSerialStore({
    ingestRx: (bytes) => m.ingestRx(bytes),
    addTx: (bytes, error) => m.addTx(bytes, error),
    settings: s.settings,
    createDriver: () => createSerialDriver(),
  })
})
