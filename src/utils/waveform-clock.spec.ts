import { describe, it, expect } from 'vitest'
import { bitsPerByte, byteTimeMs, resolveClockDomain, wireBatchXs } from './waveform-clock'

describe('waveform-clock 纯函数', () => {
  it('bitsPerByte：1 起始位 + 数据位 + 校验位 + 停止位', () => {
    expect(bitsPerByte(8, 'none', 1)).toBe(10) // 8N1（最常用）
    expect(bitsPerByte(8, 'even', 1)).toBe(11) // 8E1
    expect(bitsPerByte(7, 'none', 1)).toBe(9) // 7N1
    expect(bitsPerByte(8, 'odd', 2)).toBe(12) // 8O2
    expect(bitsPerByte(8, 'none', 1.5)).toBe(10.5) // 停止位可为 1.5
  })

  it('byteTimeMs：按波特率换算每字节耗时（毫秒）', () => {
    expect(byteTimeMs(115200, 10)).toBeCloseTo(0.0868055556, 9)
    expect(byteTimeMs(9600, 10)).toBeCloseTo(1.0416666667, 9)
    expect(byteTimeMs(9600, 10) / byteTimeMs(115200, 10)).toBeCloseTo(12, 6) // 波特率 12 倍差
  })

  it('resolveClockDomain：串口系（含 mock）合成，网络/其它到达', () => {
    for (const d of ['serialport', 'webserial', 'mock']) expect(resolveClockDomain(d)).toBe('wire')
    for (const d of ['tcp', 'rtt', 'pty', 'unsupported']) expect(resolveClockDomain(d)).toBe('arrival')
  })
})

describe('wireBatchXs（批锚定位时钟推进）', () => {
  it('批内按步长严格单调推进，首样本在锚点之后', () => {
    const r = wireBatchXs(1000, 3, 2, -Infinity)
    expect(r.xs).toEqual([1002, 1004, 1006])
    expect(r.lastSampleX).toBe(1006)
  })

  it('同毫秒连续批不折叠：第二批从上一批末样本继续', () => {
    const a = wireBatchXs(1000, 2, 2, -Infinity) // [1002, 1004]
    const b = wireBatchXs(1000, 1, 2, a.lastSampleX)
    expect(b.xs).toEqual([1006])
  })

  it('批间空档由到达时间保留（设备暂停不被压缩）', () => {
    const a = wireBatchXs(1000, 1, 2, -Infinity) // 1002
    const b = wireBatchXs(5000, 1, 2, a.lastSampleX)
    expect(b.xs).toEqual([5002]) // 暂停 4s 后仍锚定 5000，而非接着 1002 走
  })

  it('单调下限：now 落后于 lastSampleX 时不回跳（域切换保护）', () => {
    const r = wireBatchXs(1000, 1, 2, 9002)
    expect(r.xs).toEqual([9004])
  })

  it('空批/非法步长不推进时钟', () => {
    expect(wireBatchXs(1000, 0, 2, -Infinity).xs).toEqual([])
    expect(wireBatchXs(1000, 3, 0, -Infinity).xs).toEqual([])
    expect(wireBatchXs(1000, 3, NaN, -Infinity).xs).toEqual([])
    expect(wireBatchXs(1000, 3, -1, -Infinity).xs).toEqual([])
    // 未推进：lastSampleX 原样返回
    expect(wireBatchXs(1000, 0, 2, 777).lastSampleX).toBe(777)
  })
})
