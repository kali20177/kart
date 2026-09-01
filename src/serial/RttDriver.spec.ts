import { describe, it, expect, vi } from 'vitest'
import { RttDriver } from './RttDriver'
import type { ElectronTcp } from './TcpDriver'

/** 假 electron.tcp 桥（最小可 open 实例）——完整行为已在 TcpDriver.spec 覆盖，此处只验证 RTT 标识与构造传递 */
function makeFakeTcp() {
  const api: ElectronTcp = {
    open: vi.fn(async (_endpoint: string) => 'conn-1'),
    close: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    onData: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
  }
  return { api }
}

describe('RttDriver', () => {
  it('type 标识为 rtt（独立于 TCP 的驱动类型，供会话区分/默认端口）', () => {
    const d = new RttDriver()
    expect(d.type).toBe('rtt')
  })

  it('open 复用 TCP 通路：委托桥 open 端点并订阅数据/错误', async () => {
    const { api } = makeFakeTcp()
    const d = new RttDriver(api)
    expect(d.isOpen).toBe(false)
    await d.open('127.0.0.1:19021')
    expect(d.isOpen).toBe(true)
    expect(api.open).toHaveBeenCalledWith('127.0.0.1:19021')
    expect(api.onData).toHaveBeenCalled()
    expect(api.onError).toHaveBeenCalled()
    d.destroy()
  })

  it('listEndpoints 恒空（无枚举，用户手动填 host:port）', async () => {
    const d = new RttDriver(makeFakeTcp().api)
    expect(await d.listEndpoints()).toEqual([])
  })
})