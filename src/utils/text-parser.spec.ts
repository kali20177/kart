import { describe, it, expect } from 'vitest'
import { parseTextSamples } from '@/utils/text-parser'

const encoder = new TextEncoder()
const enc = (s: string) => encoder.encode(s)

describe('parseTextSamples 单值行', () => {
  it('每行一个数 -> 单通道', () => {
    const { perChannel, remainder } = parseTextSamples(enc('12.3\n'))
    expect(perChannel).toEqual([[12.3]])
    expect(remainder).toBe('')
  })

  it('多行 -> 多个采样点', () => {
    const { perChannel } = parseTextSamples(enc('1\n2\n3\n'))
    expect(perChannel).toEqual([[1, 2, 3]])
  })
})

describe('parseTextSamples 多通道', () => {
  it('逗号分隔 2 通道', () => {
    const { perChannel } = parseTextSamples(enc('1,2\n3,4\n'))
    expect(perChannel).toEqual([
      [1, 3],
      [2, 4]
    ])
  })

  it('空格 / 分号也可作分隔符', () => {
    const { perChannel } = parseTextSamples(enc('1 2 3\n4;5;6\n'))
    expect(perChannel).toEqual([
      [1, 4],
      [2, 5],
      [3, 6]
    ])
  })

  it('CRLF / CR 换行均识别', () => {
    const { perChannel } = parseTextSamples(enc('1\r\n2\r3\n'))
    expect(perChannel).toEqual([[1, 2, 3]])
  })
})

describe('parseTextSamples 数值格式', () => {
  it('符号 / 小数 / 科学计数法', () => {
    const { perChannel } = parseTextSamples(enc('-1.5 +2 .25 3e-2\n'))
    expect(perChannel).toEqual([[-1.5], [2], [0.25], [0.03]])
  })

  it('拒绝非数值 token（12abc 不当成 12）', () => {
    const { perChannel } = parseTextSamples(enc('12abc\n'))
    expect(perChannel).toEqual([[]])
  })
})

describe('parseTextSamples 短行与跳过', () => {
  it('行内数值按 token 数自动确定通道数', () => {
    const { perChannel } = parseTextSamples(enc('1,2\n'))
    // 2 个 token → 2 通道，无需配置 channels
    expect(perChannel[0]).toEqual([1])
    expect(perChannel[1]).toEqual([2])
    expect(perChannel.length).toBe(2)
  })

  it('整行无有效数值 -> 跳过，不产生采样点', () => {
    const { perChannel } = parseTextSamples(enc('hello\n\n12\n'))
    expect(perChannel).toEqual([[12]])
  })

  it('行内数值按 token 数自动扩容（不再按配置截断）', () => {
    const { perChannel } = parseTextSamples(enc('1,2,3,4\n'))
    // 4 个 token → 4 通道，不再受配置限制
    expect(perChannel).toEqual([[1], [2], [3], [4]])
  })
})

describe('parseTextSamples carryover 跨回调', () => {
  it('半截行拼到下批开头（不把 12. + 5 误判成两点）', () => {
    const r1 = parseTextSamples(enc('12.'))
    expect(r1.perChannel).toEqual([[]])
    expect(r1.remainder).toBe('12.')
    const r2 = parseTextSamples(enc('5\n'), r1.remainder)
    expect(r2.perChannel).toEqual([[12.5]])
    expect(r2.remainder).toBe('')
  })

  it('无换行的完整半截行作为 remainder 保留', () => {
    const r = parseTextSamples(enc('42'))
    expect(r.perChannel).toEqual([[]])
    expect(r.remainder).toBe('42')
  })
})

describe('parseTextSamples 终端', () => {
  it('空字节输入返回空、remainder 保留 carryover', () => {
    const r = parseTextSamples(new Uint8Array(0), '12')
    expect(r.perChannel).toEqual([[]])
    expect(r.remainder).toBe('12')
  })

  it('minChannels 始终为 1（空数据保底）', () => {
    const { perChannel } = parseTextSamples(enc('5\n'))
    expect(perChannel).toEqual([[5]])
  })
})

describe('parseTextSamples 标签化多通道', () => {
  it('label:value 格式 -> 按标签名匹配通道', () => {
    const idx = new Map<string, number>()
    const { perChannel, remainder } = parseTextSamples(enc('Sin:0.5,Cos:0.86\n'), '', idx)
    expect(remainder).toBe('')
    expect(perChannel[0]).toEqual([0.5])
    expect(perChannel[1]).toEqual([0.86])
    expect(idx.get('Sin')).toBe(0)
    expect(idx.get('Cos')).toBe(1)
  })

  it('标签跨行重排 -> 值按标签名归位', () => {
    const idx = new Map<string, number>()
    // 第一行：Cos→idx 0, Sin→idx 1
    const r1 = parseTextSamples(enc('Cos:0.86,Sin:0.5\n'), '', idx)
    expect(r1.perChannel[0]).toEqual([0.86]) // Cos
    expect(r1.perChannel[1]).toEqual([0.5])  // Sin
    // 第二行：Sin:0.7,Cos:0.9 — 调换位置，仍按标签归位
    const r2 = parseTextSamples(enc('Sin:0.7,Cos:0.9\n'), '', idx)
    // Sin→idx 1, Cos→idx 0
    expect(r2.perChannel[0]).toEqual([0.9]) // Cos（idx 0）
    expect(r2.perChannel[1]).toEqual([0.7]) // Sin（idx 1）
  })

  it('新标签出现 -> 动态分配新索引', () => {
    const idx = new Map<string, number>()
    // 第一行只有 1 个标签 token A:1 → 1 通道
    const r1 = parseTextSamples(enc('A:1\n'), '', idx)
    expect(r1.perChannel.length).toBe(1)
    expect(r1.perChannel[0][0]).toBe(1)
    // 第二行引入新标签 B → 自动扩容到 2 通道
    const r2 = parseTextSamples(enc('B:2\n'), '', idx)
    expect(r2.perChannel.length).toBe(2)
    expect(r2.perChannel[0][0]).toBe(NaN) // A 无值
    expect(r2.perChannel[1][0]).toBe(2)   // B 值
    expect(idx.size).toBe(2)
  })

  it('标签名更新 -> 新标签覆盖旧通道名', () => {
    const idx = new Map<string, number>()
    parseTextSamples(enc('Old:1\n'), '', idx)
    expect(idx.get('Old')).toBe(0)
    // 新标签名 New → 分配新索引（旧索引 0 仍被 Old 占着）
    parseTextSamples(enc('New:2\n'), '', idx)
    expect(idx.get('New')).toBe(1)
    expect(idx.get('Old')).toBe(0)
  })

  it('无标签行与有标签行混用 -> 无标签 token 按位置落位', () => {
    const idx = new Map<string, number>()
    // 先建标签映射
    parseTextSamples(enc('A:1,B:2\n'), '', idx)
    // 再发无标签行（已知 idx 不会变，parseTextSamples 接收已有 idx 但行中无标签 token → 走位置计数器）
    const { perChannel } = parseTextSamples(enc('10,20\n'), '', idx)
    // 无标签 token → posCounter 0→通道 0、posCounter 1→通道 1
    expect(perChannel[0]).toEqual([10])
    expect(perChannel[1]).toEqual([20])
  })

  it('label:value 中数值无效 -> 整 token 被忽略', () => {
    const idx = new Map<string, number>()
    const { perChannel } = parseTextSamples(enc('Temp:12abc\n'), '', idx)
    const all = perChannel.flat()
    expect(all.length).toBe(0)
  })

  it('不传 labelIndex -> 全部按位置匹配（兼容无标签数据）', () => {
    const { perChannel } = parseTextSamples(enc('Sin:0.5,Cos:0.86\n'))
    // 无 labelIndex → "Sin:0.5" 和 "Cos:0.86" 都当无标签 token，按位置落通道 0、1
    expect(perChannel[0]).toEqual([0.5])
    expect(perChannel[1]).toEqual([0.86])
  })
})
