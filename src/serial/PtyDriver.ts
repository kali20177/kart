import type { EndpointInfo, IoTransport, PortOptions, SerialSignals, DriverType } from '@/types'

/** PtyDriver 连接使用的固定端口路径（与主进程 PtyManager 约定一致） */
const PTY_PORT_PATH = 'local-shell'
/** 本地 shell 初始视口尺寸（TerminalPane fit 后经 setSize 立即校准） */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/**
 * 本地 pty 终端驱动 —— 通过 IPC 委托主进程 node-pty 运行一个本地 shell。
 *
 * 仅 Electron 环境 + DEV + `?pty` 查询参数启用，作为「本地终端」验证手段：
 * 真实行编辑、ANSI 色彩、vim/nano 全屏（尺寸经 setSize 同步给 shell 的 stty）。
 * 输出为 UTF-8 字符串经 TextEncoder 转字节流入 onData，输入同理解码。
 */
export class PtyDriver implements IoTransport {
  readonly type: DriverType = 'pty'
  private _isOpen = false
  private _listeners = new Set<(bytes: Uint8Array) => void>()
  private _unsubData: (() => void) | null = null
  private _unsubExit: (() => void) | null = null
  private _cols = INITIAL_COLS
  private _rows = INITIAL_ROWS

  get isOpen(): boolean {
    return this._isOpen
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    return [{ path: PTY_PORT_PATH, manufacturer: '本地终端 (node-pty)' }]
  }

  async open(_path: string, _options: PortOptions): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('pty 不可用')
    await api.open(PTY_PORT_PATH, { cols: this._cols, rows: this._rows })
    this._isOpen = true
    this._startListening()
  }

  async close(): Promise<void> {
    this._isOpen = false
    this._stopListening()
    const api = this._api()
    if (api) {
      try { await api.close(PTY_PORT_PATH) } catch { /* ignore */ }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('pty 不可用')
    await api.write(PTY_PORT_PATH, new TextDecoder().decode(bytes))
  }

  /** 同步窗口尺寸到本地 shell（vim 全屏必需；serialport 等无此能力则忽略） */
  async setSize(cols: number, rows: number): Promise<void> {
    this._cols = cols
    this._rows = rows
    if (!this._isOpen) return
    const api = this._api()
    if (api) {
      try { await api.resize(PTY_PORT_PATH, cols, rows) } catch { /* ignore */ }
    }
  }

  getSignals(): SerialSignals {
    // 本地 pty 无真实调制解调器信号线，固定上报 CTS/DCD/DSR（UI 显示可用）
    return { dcd: true, cts: true, dsr: true, ri: false }
  }

  async setSignals(): Promise<void> {
    // pty 无 DTR/RTS，忽略
  }

  async setBreak(): Promise<void> {
    // pty 无 Break，忽略
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  private _api(): ElectronPty | null {
    if (typeof window === 'undefined') return null
    return window.electron?.pty ?? null
  }

  private _startListening(): void {
    const api = this._api()
    if (!api) return
    this._unsubData = api.onData((data, id) => {
      if (id !== PTY_PORT_PATH) return
      const bytes = new TextEncoder().encode(data)
      for (const cb of this._listeners) {
        try { cb(bytes) } catch { /* 忽略回调异常 */ }
      }
    })
    // 本地 shell 退出 → 标记断开（serial store 的 signalTimer 检测到后走断连流程）
    this._unsubExit = api.onExit((id) => {
      if (id !== PTY_PORT_PATH) return
      this._isOpen = false
      this._stopListening()
    })
  }

  private _stopListening(): void {
    this._unsubData?.()
    this._unsubData = null
    this._unsubExit?.()
    this._unsubExit = null
  }
}

/** 预加载脚本暴露的 pty API 类型 */
export interface ElectronPty {
  open(id: string, options: { cols: number; rows: number }): Promise<void>
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  close(id: string): Promise<void>
  onData(handler: (data: string, id: string) => void): () => void
  onExit(handler: (id: string) => void): () => void
}
