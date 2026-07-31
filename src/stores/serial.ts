import { defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import type { MockScenarioId, PortInfo, PortOptions, SerialSignals, CustomBaudRate, ChecksumAlgorithm, SerialDriver } from '@/types'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { WebSerialDriver } from '@/serial/WebSerialDriver'
import { SerialPortDriver } from '@/serial/SerialPortDriver'
import { createSerialDriver, getDriverType, getUnsupportedReason, setDriverType, type DriverType } from '@/serial'
import { concatBytes, encodeText, lineEndingBytes } from '@/utils/encoding'
import { parseHexInput } from '@/utils/hex'
import { computeChecksum } from '@/utils/checksum'
import { isPresetBaud, isValidBaud, loadCustomBaudRates } from '@/utils/baud'
import { shouldReconnect } from '@/utils/reconnect'
import type { DataMode, LineEnding } from '@/types'
import { storage } from '@/composables/useStorage'
import { logger } from '@/utils/logger'
import { useMessagesStore } from './messages'
import { useSettingsStore } from './settings'

/** serial store 的外部依赖——RX/TX 帧写入委托给 messages，自动重连开关来自全局设置。
 *  ingestRx/addTx 由调用方注入；settings 是全局 settings store 的同一 reactive proxy。 */
export interface SerialDeps {
  ingestRx: (bytes: Uint8Array) => void
  addTx: (bytes: Uint8Array, error?: string) => void
  settings: { autoReconnect: boolean }
}

// 自动重连：固定 2s 间隔，不限次数；用户断开或关闭开关则停止。
const RECONNECT_INTERVAL_MS = 2000

const DEFAULT_OPTS: PortOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

export function createSerialStore(deps: SerialDeps) {
  let driver: SerialDriver = createSerialDriver()
  const driverType = ref<DriverType>(getDriverType())
  const unsupportedReason = ref(getUnsupportedReason())

  const ports = ref<PortInfo[]>([])
  const selectedPort = ref<string | null>(null)
  const connected = ref(false)
  const options = reactive<PortOptions>({
    ...DEFAULT_OPTS,
    ...storage.get('portOptions', {})
  })
  const scenario = ref<MockScenarioId>('at-reply')
  const signals = ref<SerialSignals>({ dcd: false, cts: false, dsr: false, ri: false })
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
    ports.value = await driver.listPorts()
    if (!selectedPort.value && ports.value.length > 0) {
      selectedPort.value = ports.value[0].path
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
    storage.set('portOptions', { ...options })
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
    signalTimer = setInterval(() => {
      if (!driver.isOpen) {
        // 驱动检测到物理断连，触发 full cleanup。
        // 非用户主动断开 → 标记原因以便 disconnect 启动自动重连。
        userInitiatedDisconnect = false
        logger.warn('serial', 'device lost (driver reported closed)')
        void disconnect()
        return
      }
      signals.value = driver.getSignals()
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
    // 设备重新枚举后仍未归位（仍被拔出）→ 跳过本次，排程下一次
    if (!ports.value.some((p) => p.path === selectedPort.value)) {
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

  /** 切换驱动类型（仅 DEV 模式生效） */
  async function switchDriver(type: DriverType) {
    if (type === driverType.value) return
    if (connected.value) await userDisconnect()
    // 切换驱动期间停止任何挂起的自动重连（端口/驱动都已变化）
    stopReconnectTimer()
    reconnecting.value = false
    reconnectNextAt.value = null
    reconnectAttempts.value = 0
    const prevDriver = driver
    setDriverType(type)
    driverType.value = getDriverType()
    unsupportedReason.value = getUnsupportedReason()
    driver = createSerialDriver()
    // 销毁旧驱动（serialport/webserial 都持有需要清理的本地资源）
    if (prevDriver instanceof WebSerialDriver || prevDriver instanceof SerialPortDriver) {
      prevDriver.destroy()
    }
    // re-seed scenario for mock
    if (driver instanceof MockSerialSource) {
      driver.setScenario(scenario.value)
    }
    selectedPort.value = null
    await refreshPorts()
  }

  /** 新增自定义波特率（非法值/预设档位/已存在项会被忽略） */
  function addCustomBaudRate(baud: number) {
    if (!isValidBaud(baud)) return
    if (isPresetBaud(baud)) return
    if (customBaudRates.value.some((c) => c.baud === baud)) return
    customBaudRates.value = [...customBaudRates.value, { baud }].sort((a, b) => a.baud - b.baud)
    storage.set('customBaudRates', customBaudRates.value)
  }

  /** 删除自定义波特率（预设档位不在 customBaudRates 中，天然不可删） */
  function removeCustomBaudRate(baud: number) {
    customBaudRates.value = customBaudRates.value.filter((c) => c.baud !== baud)
    storage.set('customBaudRates', customBaudRates.value)
  }

  /** 更新自定义波特率的标注（空串清除标注） */
  function updateCustomBaudNote(baud: number, note: string) {
    const trimmed = note.trim()
    customBaudRates.value = customBaudRates.value.map((c) =>
      c.baud === baud ? { ...c, note: trimmed || undefined } : c
    )
    storage.set('customBaudRates', customBaudRates.value)
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
      deps.addTx(bytes, msg)
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
      if (record) deps.addTx(bytes, msg)
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
      deps.addTx(bytes, msg)
      return { ok: false, error: msg }
    }
  }

  /** 恢复串口相关默认配置（端口参数 + 自定义波特率），不影响连接/会话状态 */
  function reset() {
    Object.assign(options, DEFAULT_OPTS)
    customBaudRates.value = []
    storage.set('portOptions', { ...DEFAULT_OPTS })
    storage.set('customBaudRates', [])
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

  return {
    ports,
    selectedPort,
    connected,
    options,
    scenario,
    signals,
    rxBytes,
    txBytes,
    sessionStartedAt,
    customBaudRates,
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
    setScenario,
    switchDriver,
    addCustomBaudRate,
    removeCustomBaudRate,
    updateCustomBaudNote,
    send,
    sendRaw,
    resend,
    onTxData,
    onData,
    reset
  }
}

export const useSerialStore = defineStore('serial', () => {
  const m = useMessagesStore()
  const s = useSettingsStore()
  return createSerialStore({
    ingestRx: (bytes) => m.ingestRx(bytes),
    addTx: (bytes, error) => m.addTx(bytes, error),
    settings: s.settings,
  })
})
