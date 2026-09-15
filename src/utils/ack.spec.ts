import { describe, it, expect } from 'vitest'
import { NACK_BYTE, isNackByte, le16, matchEchoCrc } from './ack'

describe('isNackByte / le16', () => {
  it('NACK 即 ASCII NAK (0x15)', () => {
    expect(NACK_BYTE).toBe(0x15)
    expect(isNackByte(0x15)).toBe(true)
    expect(isNackByte(0x06)).toBe(false)
  })

  it('le16 小端合成', () => {
    expect(le16(0x34, 0x12)).toBe(0x1234)
    expect(le16(0xff, 0xff)).toBe(0xffff)
  })
})

describe('matchEchoCrc', () => {
  it('缓冲不足 2 字节时返回 false（继续等待）', () => {
    expect(matchEchoCrc([0x34], 0x1234)).toBe(false)
    expect(matchEchoCrc([], 0x1234)).toBe(false)
  })

  it('前两字节按小端与期望值匹配', () => {
    expect(matchEchoCrc([0x34, 0x12], 0x1234)).toBe(true)
    expect(matchEchoCrc([0x34, 0x12, 0x00], 0x1234)).toBe(true) // 后续字节忽略
  })

  it('不匹配返回 false（触发重试）', () => {
    expect(matchEchoCrc([0x35, 0x12], 0x1234)).toBe(false)
    expect(matchEchoCrc([0x34, 0x13], 0x1234)).toBe(false)
  })
})