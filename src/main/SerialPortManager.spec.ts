import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mock 类与实例数组都在 vi.hoisted 中定义：hoisted 早于 vi.mock 执行，
// 工厂可引用 MockSerialPort，测试拿到强类型实例数组（无需 any）。
const { MockSerialPort, portInstances } = vi.hoisted(() => {
  const portInstances: MockSerialPort[] = []
  // 最小可观察的 SerialPort 替身：EventEmitter 语义 + vi.fn 方法便于断言调用
  class MockSerialPort {
    _h: Record<string, Array<(...a: unknown[]) => void>> = {}
    on(ev: string, cb: (...a: unknown[]) => void) {
      (this._h[ev] ??= []).push(cb)
      return this
    }
    emit(ev: string, ...args: unknown[]) {
      (this._h[ev] ??= []).forEach((cb) => cb(...args))
    }
    open = vi.fn((cb: (e: Error | null) => void) => {
      this.emit('open')
      cb(null)
    })
    close = vi.fn(() => {
      this.emit('close')
    })
    write = vi.fn((_d: unknown, cb: (e: Error | null) => void) => cb(null))
    drain = vi.fn((cb: (e: Error | null) => void) => cb(null))
    set = vi.fn((_o: Record<string, boolean>, cb: (e: Error | null) => void) => cb(null))
    get = vi.fn((cb: (e: Error | null, s?: { cts: boolean; dsr: boolean; dcd: boolean }) => void) =>
      cb(null, { cts: false, dsr: false, dcd: false })
    )
    static list = vi.fn(async () => [] as unknown[])
    constructor() {
      portInstances.push(this)
    }
  }
  return { MockSerialPort, portInstances }
})

vi.mock('./logger', () => ({
  // 主进程 logger 可能依赖 electron，整块替换避免在 jsdom 下加载
  mainLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

vi.mock('serialport', () => ({ SerialPort: MockSerialPort }))

import { SerialPortManager } from './SerialPortManager'

const OPTS = {
  baudRate: 115200,
  dataBits: 8 as const,
  stopBits: 1 as const,
  parity: 'none' as const,
  flowControl: 'none' as const,
}

type WinArg = ConstructorParameters<typeof SerialPortManager>[0]

function makeWin() {
  const send = vi.fn()
  // SerialPortManager 仅用到 isDestroyed / webContents.send，构造一个最小桩
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as WinArg
  return { win, send }
}

describe('SerialPortManager · 多端口', () => {
  let mgr: SerialPortManager
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    portInstances.length = 0
    const ctx = makeWin()
    mgr = new SerialPortManager(ctx.win)
    send = ctx.send
  })

  afterEach(() => {
    mgr.destroy()
  })

  it('同端口二次 open 被拒绝（提示占用）', async () => {
    await mgr.open('COM5', OPTS)
    await expect(mgr.open('COM5', OPTS)).rejects.toThrow('串口已被占用')
  })

  it('不同端口可并发打开', async () => {
    await mgr.open('COM5', OPTS)
    await mgr.open('COM6', OPTS)
    expect(portInstances).toHaveLength(2)
  })

  it('数据事件 payload 携带端口路径', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('data', Buffer.from([1, 2, 3]))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('serial:data', expect.objectContaining({ path: 'COM5' }))
    expect((send.mock.calls[0][1] as { data: unknown }).data).toBeInstanceOf(Uint8Array)
  })

  it('多端口数据按路径分发（互不干扰）', async () => {
    await mgr.open('COM5', OPTS)
    await mgr.open('COM6', OPTS)
    const [p5, p6] = portInstances
    send.mockClear()
    p5.emit('data', Buffer.from([1]))
    p6.emit('data', Buffer.from([2]))
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[0][1] as { path: string }).path).toBe('COM5')
    expect((send.mock.calls[1][1] as { path: string }).path).toBe('COM6')
  })

  it('物理断连（仅 close 事件）推送断连通知 -- 自动重连依赖此信号', async () => {
    // 回归测试：旧实现 close 处理器先删 entry 再 _sendError，而 _sendError 的
    // has(path) 守卫会吞掉通知，渲染端永远收不到断连事件 -> 自动重连失效
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('close') // 模拟物理拔线（无 error 事件）
    expect(send).toHaveBeenCalledWith('serial:error', { path: 'COM5', msg: '串口已断开' })
  })

  it('主动 close(path) 不误报断连', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    mgr.close('COM5') // 先删 entry，port.close() 触发的 close 事件查不到 entry -> 不发
    expect(send).not.toHaveBeenCalled()
    // 端口已释放，可重新打开
    await expect(mgr.open('COM5', OPTS)).resolves.toBeUndefined()
  })

  it('运行时 error 推送错误并关闭端口', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('error', new Error('boom'))
    expect(send).toHaveBeenCalledWith('serial:error', { path: 'COM5', msg: '串口错误: boom' })
    // close(path) 已执行，端口释放，可重开
    await expect(mgr.open('COM5', OPTS)).resolves.toBeUndefined()
  })

  it('write 按端口路径写入并返回字节数', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    const n = await mgr.write('COM5', Buffer.from([1, 2, 3]))
    expect(n).toBe(3)
    expect(port.write).toHaveBeenCalled()
  })

  it('write 未打开端口抛错', async () => {
    await expect(mgr.write('COM9', Buffer.from([1]))).rejects.toThrow('串口未打开')
  })

  it('setSignals 调用 port.set 且只传入提供的项', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    await mgr.setSignals('COM5', { dtr: true })
    expect(port.set).toHaveBeenCalledWith({ dtr: true }, expect.any(Function))
    await mgr.setSignals('COM5', { rts: false })
    expect(port.set).toHaveBeenCalledWith({ rts: false }, expect.any(Function))
  })

  it('setSignals 未打开端口抛错', async () => {
    await expect(mgr.setSignals('COM9', { dtr: true })).rejects.toThrow('串口未打开')
  })

  it('setBreak 通过 port.set({ brk }) 置位/清除', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    await mgr.setBreak('COM5', true)
    expect(port.set).toHaveBeenCalledWith({ brk: true }, expect.any(Function))
    await mgr.setBreak('COM5', false)
    expect(port.set).toHaveBeenCalledWith({ brk: false }, expect.any(Function))
  })

  it('setBreak 未打开端口抛错', async () => {
    await expect(mgr.setBreak('COM9', true)).rejects.toThrow('串口未打开')
  })
})
