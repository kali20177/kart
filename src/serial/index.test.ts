import { describe, it, expect } from 'vitest'
import { resolveDriverType, createDriverOfType } from '@/serial'
import type { DriverType } from '@/types'

describe('resolveDriverType', () => {
  it('Electron + DEV ?pty -> pty（本地终端，优先级最高，压过 serialport 与 ?mock）', () => {
    expect(resolveDriverType({ isElectron: true, isDevMock: true, isDevPty: true, isSecureContext: true, hasWebSerial: true }))
      .toEqual({ type: 'pty', reason: null })
  })

  it('Electron 环境 -> serialport（优先级次高，压过 ?mock）', () => {
    expect(resolveDriverType({ isElectron: true, isDevMock: true, isDevPty: false, isSecureContext: true, hasWebSerial: true }))
      .toEqual({ type: 'serialport', reason: null })
  })

  it('DEV ?mock -> mock（仅次于 Electron）', () => {
    expect(resolveDriverType({ isElectron: false, isDevMock: true, isDevPty: false, isSecureContext: true, hasWebSerial: true }))
      .toEqual({ type: 'mock', reason: null })
  })

  it('非安全上下文 -> unsupported (insecure-context)，即使 hasWebSerial 也优先报 HTTPS', () => {
    expect(resolveDriverType({ isElectron: false, isDevMock: false, isDevPty: false, isSecureContext: false, hasWebSerial: true }))
      .toEqual({ type: 'unsupported', reason: 'insecure-context' })
    expect(resolveDriverType({ isElectron: false, isDevMock: false, isDevPty: false, isSecureContext: false, hasWebSerial: false }))
      .toEqual({ type: 'unsupported', reason: 'insecure-context' })
  })

  it('安全上下文 + Web Serial -> webserial', () => {
    expect(resolveDriverType({ isElectron: false, isDevMock: false, isDevPty: false, isSecureContext: true, hasWebSerial: true }))
      .toEqual({ type: 'webserial', reason: null })
  })

  it('安全上下文但无 Web Serial -> unsupported (no-web-serial)', () => {
    expect(resolveDriverType({ isElectron: false, isDevMock: false, isDevPty: false, isSecureContext: true, hasWebSerial: false }))
      .toEqual({ type: 'unsupported', reason: 'no-web-serial' })
  })
})

describe('createDriverOfType', () => {
  it('tcp -> TcpDriver（type=tcp；tcp 是用户切换的传输，不经环境解析）', () => {
    expect(createDriverOfType('tcp').type).toBe('tcp')
  })

  it('rtt -> RttDriver（type=rtt；复用 TCP 字节流通路，独立标识）', () => {
    expect(createDriverOfType('rtt').type).toBe('rtt')
  })

  it('未知类型兜底 unsupported', () => {
    expect(createDriverOfType('no-such' as DriverType).type).toBe('unsupported')
  })
})
