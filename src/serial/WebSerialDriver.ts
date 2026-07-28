import type { PortOptions, SerialSignals, SerialDriver } from '@/types'
import { logger } from '@/utils/logger'

interface PortEntry {
  key: string
  port: SerialPort
  onDisconnect: () => void
}

export class WebSerialDriver implements SerialDriver {
  private _entries: PortEntry[] = []
  private _listeners = new Set<(bytes: Uint8Array) => void>()
  private _port: SerialPort | null = null
  private _isOpen = false
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private _readLoopAbort: AbortController | null = null
  private _signalTimer: ReturnType<typeof setInterval> | null = null
  private _cachedSignals: SerialSignals = { dcd: false, cts: false, dsr: false, ri: false }
  private _counter = 0
  private _restorePromise: Promise<void>

  constructor() {
    this._restorePromise = this._restorePorts()
  }

  get isOpen(): boolean {
    return this._isOpen
  }

  async listPorts(): Promise<string[]> {
    await this._restorePromise
    return this._entries.map((e) => e.key)
  }

  /** 触发浏览器串口选择器，返回新端口的标识字符串。用户取消返回 null。 */
  async requestPort(): Promise<string | null> {
    if (!('serial' in navigator)) return null
    try {
      const port = await navigator.serial.requestPort()
      const key = this._makeKey(port)
      if (!this._entries.some((e) => e.key === key)) {
        this._addEntry(port, key)
      }
      return key
    } catch {
      return null
    }
  }

  async open(path: string, options: PortOptions): Promise<void> {
    if (this._isOpen) await this.close()

    const entry = this._entries.find((e) => e.key === path)
    if (!entry) throw new Error('未找到该端口，请重新选择')

    this._port = entry.port

    await this._port.open({
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
      flowControl: options.flowControl
    })

    if (!this._port.readable || !this._port.writable) {
      await this._port.close()
      throw new Error('端口无法读写')
    }

    this._writer = this._port.writable.getWriter()
    this._isOpen = true
    this._readLoopAbort = new AbortController()
    this._startReadLoop()
    this._pollSignals()
  }

  async close(): Promise<void> {
    this._isOpen = false
    this._stopSignalPolling()

    if (this._readLoopAbort) {
      this._readLoopAbort.abort()
      this._readLoopAbort = null
    }

    if (this._reader) {
      try { await this._reader.cancel() } catch { /* ignore */ }
      this._reader = null
    }

    if (this._writer) {
      try { await this._writer.close() } catch { /* ignore */ }
      this._writer = null
    }

    if (this._port) {
      try { await this._port.close() } catch (e) {
        // InvalidStateError 常见于已断连端口（自清理已 close），属预期，静默；
        // 其它异常（端口被占用未真正关闭等）落控制台便于排查「断开后连不回去」类问题
        if (!(e instanceof DOMException && e.name === 'InvalidStateError')) {
          console.warn('[serial] port.close() failed:', e)
        }
      }
      this._port = null
    }

    this._cachedSignals = { dcd: false, cts: false, dsr: false, ri: false }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this._isOpen || !this._writer) throw new Error('端口未打开')
    await this._writer.write(bytes)
  }

  getSignals(): SerialSignals {
    return { ...this._cachedSignals }
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  destroy(): void {
    if (this._isOpen) {
      this.close().catch(() => {})
    }
    for (const e of this._entries) {
      e.port.removeEventListener('disconnect', e.onDisconnect)
    }
    this._entries = []
  }

  // ── private ──

  private _makeKey(port: SerialPort): string {
    try {
      const info = port.getInfo()
      if (info.usbVendorId && info.usbProductId) {
        const vid = info.usbVendorId.toString(16).padStart(4, '0')
        const pid = info.usbProductId.toString(16).padStart(4, '0')
        return `USB ${vid}:${pid}`
      }
    } catch { /* 旧版 Chrome getInfo 可能抛错 */ }
    this._counter++
    return `串口 ${this._counter}`
  }

  private _addEntry(port: SerialPort, key: string): void {
    const onDisconnect = () => {
      logger.warn('webserial', `device disconnected: ${key}`)
      // 如果断开的是当前活动端口，触发清理
      if (this._port === port) {
        this._isOpen = false
        this._stopSignalPolling()
        if (this._reader) {
          try { this._reader.cancel() } catch { /* ignore */ }
          this._reader = null
        }
        if (this._writer) {
          try { this._writer.close() } catch { /* ignore */ }
          this._writer = null
        }
        this._port = null
        this._cachedSignals = { dcd: false, cts: false, dsr: false, ri: false }
      }
      // 从列表中移除
      const idx = this._entries.findIndex((e) => e.port === port)
      if (idx >= 0) {
        port.removeEventListener('disconnect', onDisconnect)
        this._entries.splice(idx, 1)
      }
    }
    port.addEventListener('disconnect', onDisconnect)
    this._entries.push({ key, port, onDisconnect })
  }

  private async _restorePorts(): Promise<void> {
    if (!('serial' in navigator)) return
    try {
      const ports = await navigator.serial.getPorts()
      for (const port of ports) {
        const key = this._makeKey(port)
        if (!this._entries.some((e) => e.key === key)) {
          this._addEntry(port, key)
        }
      }
    } catch { /* 非安全上下文或 API 不可用，静默 */ }
  }

  private _emit(bytes: Uint8Array): void {
    for (const cb of this._listeners) {
      try { cb(bytes) } catch { /* 忽略回调异常 */ }
    }
  }

  /**
   * 读取循环：两层 while。外层从 port.readable 取 reader，内层连续 read。
   * - NetworkError/AbortError：流终止（物理断连/主动取消），退出外层。
   * - 其它错误（奇偶校验/帧错误/缓冲溢出等）：释放锁，让外层从新的 port.readable
   *   重新 getReader 继续。若不 releaseLock，会在同一个 errored 流上 read() 立即
   *   reject，形成微任务级紧密循环烧 CPU。port.readable 在持久断连后返回 null，
   *   外层自然退出。
   * - _isOpen 在 close() 中被率先置 false，故主动断开时本循环的自清理尾段被跳过，
   *   由 close() 接管真正的 reader/writer/port 关闭，避免与自清理竞态。
   */
  private _startReadLoop(): void {
    this._runReadLoop().catch(() => { /* 读循环结束，自清理已在内部完成 */ })
  }

  private async _runReadLoop(): Promise<void> {
    if (!this._port?.readable) return
    const signal = this._readLoopAbort!.signal
    try {
      while (this._port.readable && !signal.aborted) {
        this._reader = this._port.readable.getReader()
        try {
          while (this._isOpen && !signal.aborted) {
            const { value, done } = await this._reader.read()
            if (done) break
            if (value && value.length > 0) {
              this._emit(value)
            }
          }
        } catch (e) {
          if (
            e instanceof DOMException &&
            (e.name === 'NetworkError' || e.name === 'AbortError')
          ) {
            break // 流终止，退出外层
          }
          // 非致命错误：释放锁后由外层重新 getReader 继续读
        } finally {
          if (this._reader) {
            try { this._reader.releaseLock() } catch { /* 锁已被 cancel 释放，忽略 */ }
            this._reader = null
          }
        }
      }
    } finally {
      // 循环退出：若 _isOpen 仍为 true（非主动 close），说明流结束/断连，触发自清理
      if (this._isOpen) {
        this._isOpen = false
        this._stopSignalPolling()
        this._port = null
        this._writer = null
      }
    }
  }

  private _stopSignalPolling(): void {
    if (this._signalTimer) {
      clearInterval(this._signalTimer)
      this._signalTimer = null
    }
  }

  private async _pollSignals(): Promise<void> {
    this._stopSignalPolling()
    this._signalTimer = setInterval(async () => {
      if (!this._isOpen || !this._port) return
      try {
        const s = await this._port.getSignals()
        this._cachedSignals = {
          dcd: s.dataCarrierDetect ?? false,
          cts: s.clearToSend ?? false,
          dsr: s.dataSetReady ?? false,
          ri: s.ringIndicator ?? false
        }
      } catch { /* 某些硬件/虚拟串口不支持 getSignals，保持上次缓存 */ }
    }, 500)
  }
}
