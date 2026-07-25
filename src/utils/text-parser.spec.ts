import { describe, it, expect } from 'vitest'
import { parseTextSamples } from '@/utils/text-parser'
import type { WaveformParseConfig } from '@/types'

const encoder = new TextEncoder()
const enc = (s: string) => encoder.encode(s)

const cfg = (over: Partial<WaveformParseConfig> = {}): WaveformParseConfig => ({
  format: 'text',
  type: 'int16',
  littleEndian: true,
  channels: 1,
  byteOffset: 0,
  ...over
})

describe('parseTextSamples 单值行', () => {
  it('每行一个数 -> 单通道', () => {
    const c = cfg({ channels: 1 })
    const { perChannel, remainder } = parseTextSamples(enc('12.3\n'), c)
    expect(perChannel).toEqual([[12.3]])
    expect(remainder).toBe('')
  })

  it('多行 -> 多个采样点', () => {
    const c = cfg({ channels: 1 })
    const { perChannel } = parseTextSamples(enc('1\n2\n3\n'), c)
    expect(perChannel).toEqual([[1, 2, 3]])
  })
})

describe('parseTextSamples 多通道', () => {
  it('逗号分隔 2 通道', () => {
    const c = cfg({ channels: 2 })
    const { perChannel } = parseTextSamples(enc('1,2\n3,4\n'), c)
    expect(perChannel).toEqual([
      [1, 3],
      [2, 4]
    ])
  })

  it('空格 / 分号也可作分隔符', () => {
    const c = cfg({ channels: 3 })
    const { perChannel } = parseTextSamples(enc('1 2 3\n4;5;6\n'), c)
    expect(perChannel).toEqual([
      [1, 4],
      [2, 5],
      [3, 6]
    ])
  })

  it('CRLF / CR 换行均识别', () => {
    const c = cfg({ channels: 1 })
    const { perChannel } = parseTextSamples(enc('1\r\n2\r3\n'), c)
    expect(perChannel).toEqual([[1, 2, 3]])
  })
})

describe('parseTextSamples 数值格式', () => {
  it('符号 / 小数 / 科学计数法', () => {
    const c = cfg({ channels: 4 })
    const { perChannel } = parseTextSamples(enc('-1.5 +2 .25 3e-2\n'), c)
    expect(perChannel).toEqual([[-1.5], [2], [0.25], [0.03]])
  })

  it('拒绝非数值 token（12abc 不当成 12）', () => {
    const c = cfg({ channels: 1 })
    const { perChannel } = parseTextSamples(enc('12abc\n'), c)
    expect(perChannel).toEqual([[]])
  })
})

describe('parseTextSamples 短行与跳过', () => {
  it('行内数值少于通道数 -> 缺口补 NaN', () => {
    const c = cfg({ channels: 3 })
    const { perChannel } = parseTextSamples(enc('1,2\n'), c)
    expect(perChannel[0]).toEqual([1])
    expect(perChannel[1]).toEqual([2])
    expect(perChannel[2]).toEqual([NaN])
  })

  it('整行无有效数值 -> 跳过，不产生采样点', () => {
    const c = cfg({ channels: 1 })
    const { perChannel } = parseTextSamples(enc('hello\n\n12\n'), c)
    expect(perChannel).toEqual([[12]])
  })

  it('行内数值多于通道数 -> 多余忽略', () => {
    const c = cfg({ channels: 2 })
    const { perChannel } = parseTextSamples(enc('1,2,3,4\n'), c)
    expect(perChannel).toEqual([[1], [2]])
  })
})

describe('parseTextSamples carryover 跨回调', () => {
  it('半截行拼到下批开头（不把 12. + 5 误判成两点）', () => {
    const c = cfg({ channels: 1 })
    const r1 = parseTextSamples(enc('12.'), c)
    expect(r1.perChannel).toEqual([[]])
    expect(r1.remainder).toBe('12.')
    const r2 = parseTextSamples(enc('5\n'), c, r1.remainder)
    expect(r2.perChannel).toEqual([[12.5]])
    expect(r2.remainder).toBe('')
  })

  it('无换行的完整半截行作为 remainder 保留', () => {
    const c = cfg({ channels: 1 })
    const r = parseTextSamples(enc('42'), c)
    expect(r.perChannel).toEqual([[]])
    expect(r.remainder).toBe('42')
  })
})

describe('parseTextSamples 边界', () => {
  it('空字节输入返回空、remainder 保留 carryover', () => {
    const c = cfg({ channels: 1 })
    const r = parseTextSamples(new Uint8Array(0), c, '12')
    expect(r.perChannel).toEqual([[]])
    expect(r.remainder).toBe('12')
  })

  it('channels=0 被钳为 1', () => {
    const c = cfg({ channels: 0 })
    const { perChannel } = parseTextSamples(enc('5\n'), c)
    expect(perChannel).toEqual([[5]])
  })
})
