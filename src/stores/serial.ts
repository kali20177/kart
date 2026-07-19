import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import type { MockScenarioId, PortOptions, SerialSignals, CustomBaudRate, ChecksumAlgorithm, SerialDriver } from '@/types'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { WebSerialDriver } from '@/serial/WebSerialDriver'
import { createSerialDriver, getDriverType, setDriverType, type DriverType } from '@/serial'
import { concatBytes, encodeText, lineEndingBytes } from '@/utils/encoding'
import { parseHexInput } from '@/utils/hex'
import { computeChecksum } from '@/utils/checksum'
import { isPresetBaud, isValidBaud, loadCustomBaudRates } from '@/utils/baud'
import type { DataMode, LineEnding } from '@/types'
import { useMessagesStore } from './messages'
import { storage } from '@/composables/useStorage'

const DEFAULT_OPTS: PortOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

export const useSerialStore = defineStore('serial', () => {
  let driver: SerialDriver = createSerialDriver()
  const driverType = ref<DriverType>(getDriverType())
  const messages = useMessagesStore()

  const ports = ref<string[]>([])
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

  // 用户自定义波特率（可带标注，持久化）。预设档位不在此列、不可删除。
  // 读取时兼容旧版 number[] 格式（见 loadCustomBaudRates）。
  const customBaudRates = ref<CustomBaudRate[]>(
    loadCustomBaudRates(storage.get<unknown>('customBaudRates', []))
  )

  let unsubscribe: (() => void) | null = null
  let signalTimer: ReturnType<typeof setInterval> | null = null

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
      selectedPort.value = ports.value[0]
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
    await driver.open(selectedPort.value, { ...options })
    storage.set('portOptions', { ...options })
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
      messages.ingestRx(bytes)
    })
    connected.value = true
    signalTimer = setInterval(() => {
      if (!driver.isOpen) {
        // 驱动检测到物理断连，触发 full cleanup
        disconnect()
        return
      }
      signals.value = driver.getSignals()
    }, 500)
  }

  async function disconnect() {
    if (!connected.value) return
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
  }

  function setScenario(id: MockScenarioId) {
    if (!import.meta.env.DEV) return
    if (!(driver instanceof MockSerialSource)) return
    scenario.value = id
    driver.setScenario(id)
  }

  /** 手动注入模拟数据（设置面板用） */
  function inject(bytes: Uint8Array) {
    if (!import.meta.env.DEV) return
    if (!(driver instanceof MockSerialSource)) return
    driver.inject(bytes)
  }

  /** 切换驱动类型（仅 DEV 模式生效） */
  async function switchDriver(type: DriverType) {
    if (type === driverType.value) return
    if (connected.value) await disconnect()
    const prevDriver = driver
    setDriverType(type)
    driverType.value = getDriverType()
    driver = createSerialDriver()
    // 销毁旧驱动
    if (prevDriver instanceof WebSerialDriver) {
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
      messages.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      messages.addTx(bytes, msg)
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
      if (record) messages.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (record) messages.addTx(bytes, msg)
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
      messages.addTx(bytes)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      messages.addTx(bytes, msg)
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
    refreshPorts,
    requestPort,
    connect,
    disconnect,
    setScenario,
    inject,
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
})
