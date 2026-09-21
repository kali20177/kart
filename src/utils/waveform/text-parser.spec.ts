import { describe, it, expect } from 'vitest'
import { parseTextSamples, MAX_REMAINDER } from '@/utils/waveform/text-parser'

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

describe('parseTextSamples 标记模式（linePrefix）', () => {
  const marker = { linePrefix: '>' }

  /** 真机 rb-demo 实测日志行：宽松模式下它的 4 个裸数字会被当成 4 个采样值（污染源） */
  const LOG_W25Q64 =
    '[INF][    444] flash_demo(Dev::W25Q64&) at /Users/x/bsp_demo.cpp:71 [W25Q64] detected JEDEC 0xef4017, 8 MB, 128 blocks, 2048 sectors, 32768 pages\n'
  /** 真机实测：I2C 计数行（另一个污染源） */
  const LOG_I2C =
    '[INF][     41] i2c_scan(HAL::STM32F1xx::I2C_t&) at /Users/x/bsp_demo.cpp:28 [I2C] scan complete, 1 device(s)\n'

  it('宽松模式下真机日志行会污染波形（记录标记模式要解决的问题）', () => {
    const idx = new Map<string, number>()
    const { perChannel } = parseTextSamples(enc(LOG_W25Q64), '', idx)
    // 8 MB / 128 blocks / 2048 sectors / 32768 pages → 4 个裸数字被当成 4 个通道的值
    expect(perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([8, 128, 2048, 32768])
  })

  it('只认前缀行：日志行一律不成点，标记行正常取值', () => {
    const idx = new Map<string, number>()
    const { perChannel, rejected } = parseTextSamples(
      enc(LOG_W25Q64 + '>Temp:28.05,Pressure:1016.67\n' + LOG_I2C + '>Temp:28.10,Pressure:1016.70\n'),
      '',
      idx,
      marker
    )
    expect(rejected).toEqual([])
    expect(perChannel[0]).toEqual([28.05, 28.1])
    expect(perChannel[1]).toEqual([1016.67, 1016.7])
    expect([...idx.keys()]).toEqual(['Temp', 'Pressure'])
  })

  it('前缀后的内容才参与取值（前缀本身不是数据）', () => {
    const { perChannel } = parseTextSamples(enc('>Temp:28.05\n'), '', new Map(), marker)
    expect(perChannel[0]).toEqual([28.05])
  })

  it('标记必须顶格：空白缩进的标记行当文本处理', () => {
    const { perChannel } = parseTextSamples(enc('  >Temp:28.05\n'), '', new Map(), marker)
    expect(perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([])
  })

  it('标记前是二进制帧残渣（控制字节）→ 仍识别为标记行（真机 RTT 混流场景）', () => {
    // 真机实测：DictLog 帧尾不带换行，文本行被粘在帧末字节之后（0x08）
    const frameTail = '\x03\x00\x00\x00\x52\x02\x00\x00\x30\x05\x02\x08'
    const { perChannel, rejected } = parseTextSamples(
      enc(frameTail + '>Temp:26.6,Pressure:1015.3\n'),
      '',
      new Map(),
      marker
    )
    expect(rejected).toEqual([])
    expect(perChannel[0]).toEqual([26.6])
    expect(perChannel[1]).toEqual([1015.3])
  })

  it('标记前是可打印文本 → 不算标记行（日志里的 > 不被当成数据）', () => {
    const { perChannel, rejected } = parseTextSamples(enc('x>1,2\n'), '', new Map(), marker)
    expect(rejected).toEqual([])
    expect(perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([])
  })

  it('标记行内含非法 token -> 整行作废并上报（不静默成点）', () => {
    const { perChannel, rejected } = parseTextSamples(
      enc('>Temp:28.05,mark\n>Temp:28.10\n'),
      '',
      new Map(),
      marker
    )
    expect(rejected).toEqual(['>Temp:28.05,mark'])
    expect(perChannel[0]).toEqual([28.1])
  })

  it('前缀后为空 -> 作废上报', () => {
    const { perChannel, rejected } = parseTextSamples(enc('>\n'), '', new Map(), marker)
    expect(rejected).toEqual(['>'])
    expect(perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([])
  })

  it('以标记字符开头的日志行 -> 被拒并可见（而非静默画错）', () => {
    const { perChannel, rejected } = parseTextSamples(
      enc('>sensor read failed, retrying in 500 ms\n'),
      '',
      new Map(),
      marker
    )
    expect(rejected).toHaveLength(1)
    expect(perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([])
  })

  it('标记行的半截跨批拼接（carryover）后正常成点', () => {
    const idx = new Map<string, number>()
    const first = parseTextSamples(enc('>Temp:2'), '', idx, marker)
    expect(first.perChannel.flat().filter((v) => !Number.isNaN(v))).toEqual([])
    const second = parseTextSamples(enc('8.05,Pressure:1016.67\n'), first.remainder, idx, marker)
    expect(second.perChannel[0]).toEqual([28.05])
    expect(second.perChannel[1]).toEqual([1016.67])
  })

  it('未传 opts 时行为与历史一致（宽松模式回归）', () => {
    const { perChannel } = parseTextSamples(enc('Temp:28.05\n'), '', new Map())
    expect(perChannel[0]).toEqual([28.05])
  })
})

describe('parseTextSamples 未终止长行上限', () => {
  it('carryover 超上限被丢弃并标记，不再无界增长', () => {
    const { remainder, remainderTruncated } = parseTextSamples(enc('x'.repeat(MAX_REMAINDER + 1)))
    expect(remainderTruncated).toBe(true)
    expect(remainder).toBe('')
  })

  it('恰好等于上限不丢（边界）', () => {
    const { remainder, remainderTruncated } = parseTextSamples(enc('x'.repeat(MAX_REMAINDER)))
    expect(remainderTruncated).toBe(false)
    expect(remainder).toHaveLength(MAX_REMAINDER)
  })

  it('丢弃后下一批正常数据仍能成点', () => {
    const idx = new Map<string, number>()
    const first = parseTextSamples(enc('y'.repeat(MAX_REMAINDER + 10)), '', idx)
    expect(first.remainder).toBe('')
    const second = parseTextSamples(enc('1,2\n'), first.remainder, idx)
    expect(second.perChannel[0]).toEqual([1])
    expect(second.perChannel[1]).toEqual([2])
  })
})
