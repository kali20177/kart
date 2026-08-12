import { describe, it, expect, beforeEach, vi } from 'vitest'

// mock 类与实例数组都在 vi.hoisted 中定义：hoisted 早于 vi.mock 执行，
// 工厂可引用 MockSocket，测试拿到强类型实例数组（无需 any）。
const { MockSocket, socketInstances } = vi.hoisted(() => {
  const socketInstances: MockSocket[] = []
  // 最小可观察的 net.Socket 替身：EventEmitter 语义 + vi.fn 方法便于断言调用
  class MockSocket {
    _h: Record<string, Array<(...a: unknown[]) => void>> = {}
    on(ev: string, cb: (...a: unknown[]) => void) {
      (this._h[ev] ??= []).push(cb)
      return this
    }
    emit(ev: string, ...args: unknown[]) {
      (this._h[ev] ??= []).forEach((cb) => cb(...args))
    }
    write = vi.fn((_d: unknown, cb?: (e: Error | null) => void) => { cb?.(null); return true })
    end = vi.fn(() => {})
    destroy = vi.fn(() => {})
    constructor() {
      socketInstances.push(this)
    }
  }
  return { MockSocket, socketInstances }
})

vi.mock('./logger', () => ({
  // 主进程 logger 可能依赖 electron，整块替换避免在 jsdom 下加载
  mainLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

// node:net 默认导出 mock：connect 返回新 MockSocket，连接回调异步触发（微任务，
// 与真实 net 一致——回调前 socket 已创建，避免同步回调读到 TDZ 的 const socket）
vi.mock('node:net', () => ({
  default: {
    connect: vi.fn((_opts: unknown, cb?: () => void) => {
      const s = new MockSocket()
      queueMicrotask(() => cb?.())
      return s
    })
  }
}))

import { TcpManager, parseEndpoint } from './TcpManager'

type WinArg = ConstructorParameters<typeof TcpManager>[0]

function makeWin() {
  const send = vi.fn()
  // TcpManager 仅用到 isDestroyed / webContents.send，构造一个最小桩
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as WinArg
  return { win, send }
}

describe('parseEndpoint', () => {
  it('解析 "host:port"（IPv4/hostname）', () => {
    expect(parseEndpoint('192.168.1.5:502')).toEqual({ host: '192.168.1.5', port: 502 })
    expect(parseEndpoint('localhost:8080')).toEqual({ host: 'localhost', port: 8080 })
  })

  it('非法输入返回 null（无冒号/空段/端口越界/非数字）', () => {
    expect(parseEndpoint('')).toBeNull()
    expect(parseEndpoint('host')).toBeNull()
    expect(parseEndpoint(':502')).toBeNull()
    expect(parseEndpoint('host:')).toBeNull()
    expect(parseEndpoint('host:0')).toBeNull()
    expect(parseEndpoint('host:70000')).toBeNull()
    expect(parseEndpoint('host:abc')).toBeNull()
  })
})

describe('TcpManager', () => {
  beforeEach(() => {
    socketInstances.length = 0
  })

  it('open 成功 → data 事件推送 tcp:data（Uint8Array + id=端点）', async () => {
    const { win, send } = makeWin()
    const mgr = new TcpManager(win)
    await mgr.open('192.168.1.5:502')
    expect(send).not.toHaveBeenCalled() // 连接本身不产生数据推送

    socketInstances[0].emit('data', Buffer.from([0xaa, 0x55, 0x01]))
    expect(send).toHaveBeenCalledWith(
      'tcp:data',
      expect.objectContaining({ id: '192.168.1.5:502', data: expect.any(Uint8Array) })
    )
    const payload = send.mock.calls[0][1] as { id: string; data: Uint8Array }
    expect(payload.id).toBe('192.168.1.5:502')
    expect(Array.from(payload.data)).toEqual([0xaa, 0x55, 0x01])
    mgr.destroy()
  })

  it('open 非法端点 → reject，不建连接', async () => {
    const mgr = new TcpManager(makeWin().win)
    await expect(mgr.open('bad-endpoint')).rejects.toThrow('无效的 TCP 端点')
    expect(socketInstances.length).toBe(0)
  })

  it('open 连接阶段错误（error 先于 connected）→ reject', async () => {
    // 直接构造：connect 回调触发前先 emit error（真实场景 connect 失败）
    const { win } = makeWin()
    const mgr = new TcpManager(win)
    const connect = (await import('node:net')).default.connect as ReturnType<typeof vi.fn>
    connect.mockImplementationOnce(() => {
      const s = new MockSocket()
      // 同步 emit error 模拟连接失败（真实 net 中 error 后不会触发 connect 回调）
      queueMicrotask(() => s.emit('error', new Error('ECONNREFUSED')))
      return s
    })
    await expect(mgr.open('h:1')).rejects.toThrow('连接 h:1 失败')
    mgr.destroy()
  })

  it('运行期错误 → 推送 tcp:error 并关闭连接', async () => {
    const { win, send } = makeWin()
    const mgr = new TcpManager(win)
    await mgr.open('h:1')
    socketInstances[0].emit('error', new Error('ECONNRESET'))
    expect(send).toHaveBeenCalledWith('tcp:error', expect.objectContaining({ id: 'h:1' }))
    expect(socketInstances[0].destroy).toHaveBeenCalled()
    // 连接已清理：再写应失败
    await expect(mgr.write('h:1', Buffer.from([1]))).rejects.toThrow('连接未打开')
    mgr.destroy()
  })

  it('write 委托 socket.write', async () => {
    const mgr = new TcpManager(makeWin().win)
    await mgr.open('h:1')
    await mgr.write('h:1', Buffer.from([0x01, 0x02]))
    expect(socketInstances[0].write).toHaveBeenCalled()
    mgr.destroy()
  })

  it('远端断开（close 事件）→ 推送 tcp:error 并清理', async () => {
    const { win, send } = makeWin()
    const mgr = new TcpManager(win)
    await mgr.open('h:1')
    socketInstances[0].emit('close')
    expect(send).toHaveBeenCalledWith(
      'tcp:error',
      expect.objectContaining({ id: 'h:1', msg: expect.stringContaining('断开') })
    )
    await expect(mgr.write('h:1', Buffer.from([1]))).rejects.toThrow('连接未打开')
    mgr.destroy()
  })

  it('主动 close 不误报断开（先删 entry 再触发 close）', async () => {
    const { win, send } = makeWin()
    const mgr = new TcpManager(win)
    await mgr.open('h:1')
    mgr.close('h:1')
    expect(send).not.toHaveBeenCalled()
    mgr.destroy()
  })

  it('destroy 关闭全部连接', async () => {
    const mgr = new TcpManager(makeWin().win)
    await mgr.open('h:1')
    await mgr.open('h:2')
    expect(socketInstances.length).toBe(2)
    mgr.destroy()
    expect(socketInstances[0].destroy).toHaveBeenCalled()
    expect(socketInstances[1].destroy).toHaveBeenCalled()
  })
})
