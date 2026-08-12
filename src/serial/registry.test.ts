import { describe, it, expect } from 'vitest'
import './index' // 导入即注册内置传输（与生产入口一致）
import { registerTransport, getTransportDef, listTransports } from './registry'
import type { DriverType, IoTransport } from '@/types'

describe('transport registry', () => {
  it('内置传输已注册（导入 index 即注册）', () => {
    const types = listTransports().map((t) => t.type)
    expect(types).toEqual(expect.arrayContaining(['serialport', 'webserial', 'tcp', 'mock', 'pty', 'unsupported']))
  })

  it('getTransportDef 按类型查询；create 产生对应类型驱动实例', () => {
    expect(getTransportDef('tcp')?.create().type).toBe('tcp')
    expect(getTransportDef('serialport')?.create().type).toBe('serialport')
    expect(getTransportDef('no-such' as DriverType)).toBeUndefined()
  })

  it('registerTransport 覆盖同名（镜像 decoders 无重名保护）', () => {
    const fake: IoTransport = { type: 'tcp', listEndpoints: async () => [], open: async () => {}, close: async () => {}, write: async () => {}, onData: () => () => {}, isOpen: false }
    registerTransport({ type: 'tcp', create: () => fake })
    expect(getTransportDef('tcp')?.create()).toBe(fake)
  })
})
