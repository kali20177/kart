import type { EndpointInfo, IoTransport, PortOptions, SerialSignals, DriverType } from '@/types'

/**
 * 不兼容占位驱动 -- 浏览器不支持 Web Serial / 非安全上下文时使用。
 *
 * 正常情况下,App.vue 的兼容性遮罩(IncompatibleBrowser)会阻断整个 UI,
 * 用户无法触发任何串口操作,此驱动的方法不会被调用。这里的抛错/no-op 仅作防御:
 * 遮罩挂载前的竞态、单测、以及未来新增的调用入口。
 *
 * 实现 IoTransport 接口是为了保持 serial store 的类型契约
 * (`let driver: IoTransport = createSerialDriver()`),无需把 driver 改成可空。
 */
export class UnsupportedDriver implements IoTransport {
  readonly type: DriverType = 'unsupported'
  private _isOpen = false

  get isOpen(): boolean {
    return this._isOpen
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    return []
  }

  async open(_path: string, _options: PortOptions): Promise<void> {
    throw new Error('当前浏览器不兼容,无法打开串口')
  }

  async close(): Promise<void> {
    this._isOpen = false
  }

  async write(_bytes: Uint8Array): Promise<void> {
    throw new Error('当前浏览器不兼容,无法写入串口')
  }

  getSignals(): SerialSignals {
    return { dcd: false, cts: false, dsr: false, ri: false }
  }

  async setSignals(_signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    throw new Error('当前浏览器不兼容,无法控制串口信号')
  }

  async setBreak(_active: boolean): Promise<void> {
    throw new Error('当前浏览器不兼容,无法控制串口信号')
  }

  onData(_cb: (bytes: Uint8Array) => void): () => void {
    return () => {}
  }
}
