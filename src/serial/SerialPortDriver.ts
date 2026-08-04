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
  private _openPath: string | null = null
  private _listeners = new Set<(bytes: Uint8Array) => void>()
  private _cachedSignals: SerialSignals = { dcd: false, cts: false, dsr: false, ri: false }
  private _signalTimer: ReturnType<typeof setInterval> | null = null
  private _unsubData: (() => void) | null = null
  private _unsubError: (() => void) | null = null

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
    this._openPath = path
    this._startListening()
    this._pollSignals()
  }

  async close(): Promise<void> {
    this._isOpen = false
    // 先捕获 path 再置空：防 close 在途事件（data/error）误入本实例
    const path = this._openPath
    this._openPath = null
    this._stopListening()
    this._stopSignalPolling()
    const api = this._api()
    if (api && path) {
      try { await api.close(path) } catch { /* ignore */ }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('serialport 不可用')
    const written = await api.write(this._openPath ?? '', bytes)
    if (written !== bytes.length) {
      console.warn('[serial] 写入字节数不匹配:', written, '/', bytes.length)
    }
  }

  getSignals(): SerialSignals {
    return { ...this._cachedSignals }
  }

  async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('serialport 不可用')
    await api.setSignals(this._openPath ?? '', signals)
  }

  async setBreak(active: boolean): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('serialport 不可用')
    await api.setBreak(this._openPath ?? '', active)
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
    this._unsubData = api.onData((data: Uint8Array, path: string) => {
      // 只处理本实例打开的端口事件（多会话并发时互不干扰）
      if (path !== this._openPath) return
      for (const cb of this._listeners) {
        try { cb(data) } catch { /* 忽略回调异常 */ }
      }
    })
    this._unsubError = api.onError((msg: string, path: string) => {
      if (path !== this._openPath) return
      console.warn('[serial] error:', msg)
      this._isOpen = false
      this._stopSignalPolling()
    })
  }

  private _stopListening(): void {
    this._unsubData?.()
    this._unsubData = null
    this._unsubError?.()
    this._unsubError = null
  }

  /** 异步轮询信号状态，写入本地缓存（getSignals 同步返回缓存） */
  private _pollSignals(): void {
    this._stopSignalPolling()
    this._signalTimer = setInterval(async () => {
      if (!this._isOpen || !this._openPath) return
      const api = this._api()
      if (!api) return
      try {
        const s = await api.getSignals(this._openPath)
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
  close(portName: string): Promise<void>
  write(portName: string, data: Uint8Array): Promise<number>
  getSignals(portName: string): Promise<{ dcd: boolean; cts: boolean; dsr: boolean; ri: boolean }>
  setSignals(portName: string, signals: { dtr?: boolean; rts?: boolean }): Promise<void>
  setBreak(portName: string, active: boolean): Promise<void>
  onData(handler: (data: Uint8Array, path: string) => void): () => void
  onError(handler: (msg: string, path: string) => void): () => void
}
