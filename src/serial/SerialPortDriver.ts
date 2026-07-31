import type { PortInfo, PortOptions, SerialSignals, SerialDriver } from '@/types'

/**
 * serialport 驱动 —— 通过 IPC 委托主进程的 serialport 库执行串口操作。
 *
 * 仅在 Electron 环境下可用，通过 window.electron.serial 与主进程通信。
 * 浏览器模式下自动回退到 WebSerialDriver。
 *
 * 相比之前的 CSerialPort 手写 addon：
 *   - 主进程读取事件驱动（非轮询），高波特率不丢字节
 *   - getSignals 返回真实 DCD/CTS/DSR/RI 状态
 *   - native bindings prebuilt，跨平台，无本机 C++ 工具链依赖
 */
export class SerialPortDriver implements SerialDriver {
  private _isOpen = false
  private _listeners = new Set<(bytes: Uint8Array) => void>()
  private _cachedSignals: SerialSignals = { dcd: false, cts: false, dsr: false, ri: false }
  private _signalTimer: ReturnType<typeof setInterval> | null = null

  get isOpen(): boolean {
    return this._isOpen
  }

  async listPorts(): Promise<PortInfo[]> {
    const api = this._api()
    if (!api) return []
    try {
      const infos = await api.listPorts()
      return infos.map((i) => ({
        path: i.path,
        manufacturer: i.manufacturer,
        vendorId: i.vendorId,
        productId: i.productId
      }))
    } catch {
      return []
    }
  }

  async open(path: string, options: PortOptions): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('serialport 不可用')
    await api.open(path, options)
    this._isOpen = true
    this._startListening()
    this._pollSignals()
  }

  async close(): Promise<void> {
    this._isOpen = false
    this._stopListening()
    this._stopSignalPolling()
    const api = this._api()
    if (api) {
      try { await api.close() } catch { /* ignore */ }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('serialport 不可用')
    const written = await api.write(bytes)
    if (written !== bytes.length) {
      console.warn('[serial] 写入字节数不匹配:', written, '/', bytes.length)
    }
  }

  getSignals(): SerialSignals {
    return { ...this._cachedSignals }
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  destroy(): void {
    this._stopListening()
    this._stopSignalPolling()
    this._listeners.clear()
    if (this._isOpen) {
      this.close().catch(() => {})
    }
  }

  // ── 私有方法 ──

  private _api(): ElectronSerial | null {
    if (typeof window === 'undefined') return null
    const s = window.electron?.serial
    return s || null
  }

  private _startListening(): void {
    const api = this._api()
    if (!api) return
    api.onData((data: Uint8Array) => {
      for (const cb of this._listeners) {
        try { cb(data) } catch { /* 忽略回调异常 */ }
      }
    })
    api.onError((msg: string) => {
      console.warn('[serial] error:', msg)
      this._isOpen = false
      this._stopSignalPolling()
    })
  }

  private _stopListening(): void {
    const api = this._api()
    if (api) {
      api.removeListeners()
    }
  }

  /** 异步轮询信号状态，写入本地缓存（getSignals 同步返回缓存） */
  private _pollSignals(): void {
    this._stopSignalPolling()
    this._signalTimer = setInterval(async () => {
      if (!this._isOpen) return
      const api = this._api()
      if (!api) return
      try {
        const s = await api.getSignals()
        this._cachedSignals = {
          dcd: s.dcd,
          cts: s.cts,
          dsr: s.dsr,
          ri: s.ri
        }
      } catch { /* 某些虚拟串口不支持 getSignals，保持上次缓存 */ }
    }, 500)
  }

  private _stopSignalPolling(): void {
    if (this._signalTimer) {
      clearInterval(this._signalTimer)
      this._signalTimer = null
    }
    this._cachedSignals = { dcd: false, cts: false, dsr: false, ri: false }
  }
}

/** 预加载脚本暴露的 serial API 类型 */
export interface ElectronSerial {
  listPorts(): Promise<PortInfo[]>
  open(portName: string, options: PortOptions): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array): Promise<number>
  getSignals(): Promise<{ dcd: boolean; cts: boolean; dsr: boolean; ri: boolean }>
  isOpen(): Promise<boolean>
  onData(handler: (data: Uint8Array) => void): void
  onError(handler: (msg: string) => void): void
  removeListeners(): void
}