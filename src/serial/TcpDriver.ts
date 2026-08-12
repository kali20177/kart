// TCP client 驱动 —— 通过 IPC 委托主进程 net 模块建立 TCP 连接。
//
// 仅 Electron 环境下可用（依赖 window.electron.tcp）；浏览器模式无此传输。
// 端点即 "host:port" 字符串；无端口枚举（listEndpoints 返回空，用户手动填）。
// 串口信号线方法（getSignals/setSignals/setBreak）为可选扩展，TCP 无调制解调器线，不实现。
//
// 断连语义：远端断开/错误经 onError 置 _isOpen=false，serial store 的 500ms
// signalTimer 轮询检测后走断连/自动重连流程（与 SerialPortDriver 一致）。

import type { EndpointInfo, IoTransport, DriverType } from '@/types'

export class TcpDriver implements IoTransport {
  readonly type: DriverType = 'tcp'
  private _isOpen = false
  private _openEndpoint: string | null = null
  private _listeners = new Set<(bytes: Uint8Array) => void>()
  private _unsubData: (() => void) | null = null
  private _unsubError: (() => void) | null = null

  constructor(private _apiOverride?: ElectronTcp) {}

  get isOpen(): boolean {
    return this._isOpen
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    // TCP 无枚举：用户手动填 host:port
    return []
  }

  async open(endpoint: string, _options?: unknown): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('TCP 不可用（需 Electron 环境）')
    await api.open(endpoint)
    this._isOpen = true
    this._openEndpoint = endpoint
    this._startListening()
  }

  async close(): Promise<void> {
    this._isOpen = false
    // 先捕获 endpoint 再置空：防 close 在途事件（data/error）误入本实例
    const endpoint = this._openEndpoint
    this._openEndpoint = null
    this._stopListening()
    const api = this._api()
    if (api && endpoint) {
      try { await api.close(endpoint) } catch { /* ignore */ }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const api = this._api()
    if (!api) throw new Error('TCP 不可用（需 Electron 环境）')
    await api.write(this._openEndpoint ?? '', bytes)
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  destroy(): void {
    this._stopListening()
    this._listeners.clear()
    if (this._isOpen) {
      this.close().catch(() => {})
    }
  }

  // ── 私有方法 ──

  private _api(): ElectronTcp | null {
    return this._apiOverride ?? (typeof window !== 'undefined' ? window.electron?.tcp ?? null : null)
  }

  private _startListening(): void {
    const api = this._api()
    if (!api) return
    this._unsubData = api.onData((data: Uint8Array, id: string) => {
      // 只处理本实例打开的端点事件（多会话并发时互不干扰）
      if (id !== this._openEndpoint) return
      for (const cb of this._listeners) {
        try { cb(data) } catch { /* 忽略回调异常 */ }
      }
    })
    this._unsubError = api.onError((_msg: string, id: string) => {
      if (id !== this._openEndpoint) return
      // 远端断开/错误 → 标记断开（store 轮询据此触发断连/重连）
      this._isOpen = false
      this._stopListening()
    })
  }

  private _stopListening(): void {
    this._unsubData?.()
    this._unsubData = null
    this._unsubError?.()
    this._unsubError = null
  }
}

/** 预加载脚本暴露的 tcp API 类型 */
export interface ElectronTcp {
  open(endpoint: string): Promise<void>
  close(endpoint: string): Promise<void>
  write(endpoint: string, data: Uint8Array): Promise<void>
  onData(handler: (data: Uint8Array, id: string) => void): () => void
  onError(handler: (msg: string, id: string) => void): () => void
}
