import { describe, it, expect } from 'vitest'
import { parseSamples, recordSize, bytesPerSample } from '@/utils/byte-parser'
import type { WaveformParseConfig } from '@/types'

const cfg = (over: Partial<WaveformParseConfig> = {}): WaveformParseConfig => ({
  type: 'int16',
  littleEndian: true,
  channels: 1,
  byteOffset: 0,
  ...over
})

describe('bytesPerSample', () => {
  it('按类型返回字节数', () => {
    expect(bytesPerSample('uint8')).toBe(1)
    expect(bytesPerSample('int16')).toBe(2)
    expect(bytesPerSample('float32')).toBe(4)
    expect(bytesPerSample('float64')).toBe(8)
  })
})

describe('recordSize', () => {
  it('偏移 + 通道数 × 每采样字节数', () => {
    expect(recordSize(cfg({ type: 'int16', channels: 2, byteOffset: 0 }))).toBe(4)
    expect(recordSize(cfg({ type: 'int16', channels: 2, byteOffset: 2 }))).toBe(6)
    expect(recordSize(cfg({ type: 'uint8', channels: 3, byteOffset: 1 }))).toBe(4)
  })
})

describe('parseSamples uint8', () => {
  it('单通道逐字节读出', () => {
    const c = cfg({ type: 'uint8', channels: 1 })
    const { perChannel, remainder } = parseSamples(new Uint8Array([10, 20, 30]), c)
    expect(perChannel).toEqual([[10, 20, 30]])
    expect(Array.from(remainder)).toEqual([])
  })
})

describe('parseSamples int16 LE/BE', () => {
  it('小端：FF 7F = 32767', () => {
    const c = cfg({ type: 'int16', littleEndian: true, channels: 1 })
    const { perChannel } = parseSamples(new Uint8Array([0xff, 0x7f]), c)
    expect(perChannel).toEqual([[32767]])
  })

  it('大端：7F FF = 32767', () => {
    const c = cfg({ type: 'int16', littleEndian: false, channels: 1 })
    const { perChannel } = parseSamples(new Uint8Array([0x7f, 0xff]), c)
    expect(perChannel).toEqual([[32767]])
  })

  it('int16 负值：00 80 LE = -32768', () => {
    const c = cfg({ type: 'int16', littleEndian: true, channels: 1 })
    const { perChannel } = parseSamples(new Uint8Array([0x00, 0x80]), c)
    expect(perChannel).toEqual([[-32768]])
  })
})

describe('parseSamples 多通道交错', () => {
  it('2 通道 int16 LE 交错', () => {
    // record = ch0(01 00=1), ch1(02 00=2) | ch0(03 00=3), ch1(04 00=4)
    const c = cfg({ type: 'int16', littleEndian: true, channels: 2 })
    const { perChannel, remainder } = parseSamples(
      new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00]),
      c
    )
    expect(perChannel).toEqual([
      [1, 3],
      [2, 4]
    ])
    expect(Array.from(remainder)).toEqual([])
  })
})

describe('parseSamples float32', () => {
  it('小端读出 1.0', () => {
    const c = cfg({ type: 'float32', littleEndian: true, channels: 1 })
    // 1.0f = 00 00 80 3F (LE)
    const { perChannel } = parseSamples(new Uint8Array([0x00, 0x00, 0x80, 0x3f]), c)
    expect(perChannel[0][0]).toBeCloseTo(1.0, 6)
  })
})

describe('parseSamples byteOffset 帧头', () => {
  it('跳过每 record 起始 2 字节帧头', () => {
    // record = AA 55 | ch0(0A 00=10) | ch1(14 00=20)
    const c = cfg({ type: 'int16', littleEndian: true, channels: 2, byteOffset: 2 })
    const { perChannel, remainder } = parseSamples(
      new Uint8Array([0xaa, 0x55, 0x0a, 0x00, 0x14, 0x00]),
      c
    )
    expect(perChannel).toEqual([[10], [20]])
    expect(Array.from(remainder)).toEqual([])
  })
})

describe('parseSamples carryover 跨回调承接', () => {
  it('半截采样拼到下批开头', () => {
    const c = cfg({ type: 'int16', littleEndian: true, channels: 1 })
    // 第一批只有 3 字节 = 1 完整 record(01 00) + 1 字节零头(02)
    const r1 = parseSamples(new Uint8Array([0x01, 0x00, 0x02]), c)
    expect(r1.perChannel).toEqual([[1]])
    expect(Array.from(r1.remainder)).toEqual([0x02])
    // 第二批把零头接上：02 + 00 = 2
    const r2 = parseSamples(new Uint8Array([0x00, 0x05, 0x00]), c, r1.remainder)
    expect(r2.perChannel).toEqual([[2, 5]])
    expect(Array.from(r2.remainder)).toEqual([])
  })

  it('全为零头时原样返回', () => {
    const c = cfg({ type: 'int16', littleEndian: true, channels: 1 })
    const r = parseSamples(new Uint8Array([0x01]), c)
    expect(r.perChannel).toEqual([[]])
    expect(Array.from(r.remainder)).toEqual([0x01])
  })
})

describe('parseSamples 边界', () => {
  it('空字节输入返回空', () => {
    const c = cfg({ type: 'uint8', channels: 2 })
    const r = parseSamples(new Uint8Array(0), c)
    expect(r.perChannel).toEqual([[], []])
    expect(Array.from(r.remainder)).toEqual([])
  })

  it('channels=0 被钳为 1，避免除零', () => {
    const c = cfg({ type: 'uint8', channels: 0 })
    expect(recordSize(c)).toBe(1)
    const r = parseSamples(new Uint8Array([5]), c)
    expect(r.perChannel).toEqual([[5]])
  })
})
