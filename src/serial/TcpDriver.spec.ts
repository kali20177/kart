import { describe, it, expect, vi } from 'vitest'
import { TcpDriver, type ElectronTcp } from './TcpDriver'

/** 假 electron.tcp 桥：内存 handler 集合，测试侧可注入远端字节/断连事件。
 *  open 返回主进程分配的连接 id（connId），后续事件/读写按 connId 路由。 */
function makeFakeTcp() {
  const dataHandlers = new Set<(data: Uint8Array, id: string) => void>()
  const errorHandlers = new Set<(msg: string, id: string) => void>()
  const api: ElectronTcp = {
    open: vi.fn(async (_endpoint: string) => 'conn-1'),
    close: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    onData: vi.fn((h) => {
      dataHandlers.add(h)
      return () => { dataHandlers.delete(h) }
    }),
    onError: vi.fn((h) => {
      errorHandlers.add(h)
      return () => { errorHandlers.delete(h) }
    }),
  }
  return { api, dataHandlers, errorHandlers }
}

describe('TcpDriver', () => {
  it('open 成功 → isOpen/端点记录/订阅桥数据与错误事件', async () => {
    const { api } = makeFakeTcp()
    const d = new TcpDriver(api)
    expect(d.isOpen).toBe(false)
    await d.open('192.168.1.5:502')
    expect(d.isOpen).toBe(true)
    expect(api.open).toHaveBeenCalledWith('192.168.1.5:502')
    expect(api.onData).toHaveBeenCalled()
    expect(api.onError).toHaveBeenCalled()
    d.destroy()
  })

  it('无桥（非 Electron）→ open 拒绝', async () => {
    const d = new TcpDriver(undefined)
    await expect(d.open('h:1')).rejects.toThrow('TCP 不可用')
    expect(d.isOpen).toBe(false)
  })

  it('listEndpoints 恒空（TCP 无枚举，用户手动填）', async () => {
    const d = new TcpDriver(makeFakeTcp().api)
    expect(await d.listEndpoints()).toEqual([])
  })

  it('onData 仅转发本连接（connId）字节，其他连接事件丢弃（多会话并发隔离）', async () => {
    const { api, dataHandlers } = makeFakeTcp()
    const d = new TcpDriver(api)
    await d.open('h:1') // 假桥返回 conn-1
    const received: Uint8Array[] = []
    d.onData((b) => received.push(b))

    for (const h of dataHandlers) h(new Uint8Array([1, 2]), 'conn-1')
    for (const h of dataHandlers) h(new Uint8Array([9, 9]), 'conn-2') // 其他连接 → 丢弃
    expect(received.length).toBe(1)
    expect(Array.from(received[0])).toEqual([1, 2])
    d.destroy()
  })

  it('write 委托桥按 connId 写入字节', async () => {
    const { api } = makeFakeTcp()
    const d = new TcpDriver(api)
    await d.open('h:1')
    await d.write(new Uint8Array([0xaa, 0x55]))
    expect(api.write).toHaveBeenCalledWith('conn-1', new Uint8Array([0xaa, 0x55]))
    d.destroy()
  })

  it('本连接断连（onError）→ isOpen=false 并停止监听；他连接断连不影响', async () => {
    const { api, dataHandlers, errorHandlers } = makeFakeTcp()
    const d = new TcpDriver(api)
    await d.open('h:1')

    // 其他连接断连：与本实例无关，忽略
    for (const h of errorHandlers) h('连接已断开', 'conn-2')
    expect(d.isOpen).toBe(true)

    // 本连接断连：标记断开并退订
    for (const h of errorHandlers) h('连接已断开', 'conn-1')
    expect(d.isOpen).toBe(false)
    // 退订后桥的 onData/onError handler 已移除（_stopListening 清空）
    expect(dataHandlers.size).toBe(0)
    expect(errorHandlers.size).toBe(0)
    d.destroy()
  })

  it('close 置断开、退订桥事件并通知主进程关闭；close 后不再转发字节', async () => {
    const { api, dataHandlers } = makeFakeTcp()
    const d = new TcpDriver(api)
    await d.open('h:1')
    const received: Uint8Array[] = []
    d.onData((b) => received.push(b))

    await d.close()
    expect(d.isOpen).toBe(false)
    expect(api.close).toHaveBeenCalledWith('conn-1')
    expect(dataHandlers.size).toBe(0) // 已退订

    // close 在途事件（若桥仍持有陈旧引用）因 _connId 置空而被过滤
    for (const h of dataHandlers) h(new Uint8Array([0xff]), 'conn-1')
    expect(received.length).toBe(0)
    d.destroy()
  })

  it('destroy 关闭未结束连接并清空监听', async () => {
    const { api } = makeFakeTcp()
    const d = new TcpDriver(api)
    await d.open('h:1')
    d.destroy()
    expect(api.close).toHaveBeenCalledWith('conn-1')
  })
})
