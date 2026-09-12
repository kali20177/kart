import { describe, it, expect } from 'vitest'
import { TextLineParser } from './waveform-parser'
import type { WireClockConfig } from './waveform-clock'

const enc = (s: string) => new TextEncoder().encode(s)

const wire = (over: Partial<WireClockConfig> = {}): WireClockConfig => ({
  domain: 'wire',
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  ...over,
})

/** 115200 8N1 下每字节耗时（毫秒） */
const BYTE_MS = (10 / 115200) * 1000

describe('TextLineParser 时钟域（X 策略）', () => {
  it('未注入 clock：到达时间 + 逐行 +1ms（历史行为回归）', () => {
    const p = new TextLineParser()
    expect(p.ingest(enc('1\n2\n'), 1000).xs).toEqual([1000, 1001])
    // 同毫秒第二批：从上一采样 +1 继续
    expect(p.ingest(enc('3\n'), 1000).xs).toEqual([1002])
  })

  it('wire 域：批内按「完整行字节 × 位时间 ÷ n」均摊', () => {
    const p = new TextLineParser(() => wire())
    // '10\n20\n30\n' = 9 字节 / 3 行 → 每行步长 = 9 * BYTE_MS / 3
    const r = p.ingest(enc('10\n20\n30\n'), 1000)
    const step = (9 * BYTE_MS) / 3
    expect(r.xs).toHaveLength(3)
    expect(r.xs[0]).toBeCloseTo(1000 + step, 9)
    expect(r.xs[1] - r.xs[0]).toBeCloseTo(step, 9)
    expect(r.xs[2] - r.xs[1]).toBeCloseTo(step, 9)
  })

  it('wire 域：只计完整行字节，尾部半截行不计入本批步长', () => {
    const p = new TextLineParser(() => wire())
    // '1\n2'：完整行 '1\n' 占 2 字节，尾部半截 '2' 归下一批，不计入
    const r = p.ingest(enc('1\n2'), 1000)
    expect(r.xs).toHaveLength(1)
    expect(r.xs[0]).toBeCloseTo(1000 + 2 * BYTE_MS, 9)
  })

  it('wire 域：跨批 carryover 的字节归属正确（半截行不重复计或少计）', () => {
    const p = new TextLineParser(() => wire())
    p.ingest(enc('1.'), 1000) // 半截行，无采样
    const r = p.ingest(enc('5\n'), 1001) // 本批完整行 '1.5\n' = 4 字节
    expect(r.perChannel[0]).toEqual([1.5])
    expect(r.xs[0]).toBeCloseTo(1001 + 4 * BYTE_MS, 9)
  })

  it('wire 域：批间空档保留（设备暂停不被压缩）', () => {
    const p = new TextLineParser(() => wire())
    p.ingest(enc('1\n'), 1000) // ≈ 1000.17
    const r = p.ingest(enc('2\n'), 3000) // 暂停 2s
    expect(r.xs[0]).toBeGreaterThan(2999)
  })

  it('wire 域：同毫秒连续批严格递增', () => {
    const p = new TextLineParser(() => wire())
    const a = p.ingest(enc('1\n'), 1000)
    const b = p.ingest(enc('2\n'), 1000)
    expect(b.xs[0]).toBeGreaterThan(a.xs[0])
  })

  it('波特率热更新：新步长从下一批生效，不改既有采样', () => {
    let baud = 115200
    const p = new TextLineParser(() => wire({ baudRate: baud }))
    const a = p.ingest(enc('1\n'), 1000)
    expect(a.xs[0]).toBeCloseTo(1000 + 2 * BYTE_MS, 9)
    baud = 9600 // 每字节耗时变为 12 倍
    const b = p.ingest(enc('2\n'), 2000)
    expect(b.xs[0] - 2000).toBeCloseTo(2 * (10 / 9600) * 1000, 9)
  })

  it('域切换（wire → arrival → wire）：X 不回跳，保持全局单调', () => {
    const cfg = wire()
    const p = new TextLineParser(() => cfg)
    const w = p.ingest(enc('1\n'), 9000) // wire：≈ 9000.17
    cfg.domain = 'arrival'
    const a = p.ingest(enc('2\n'), 1000) // now 落后于旧 X
    expect(a.xs[0]).toBeGreaterThan(w.xs[0]) // 不倒退（uPlot 要求 X 递增）
    cfg.domain = 'wire'
    const w2 = p.ingest(enc('3\n'), 1000)
    expect(w2.xs[0]).toBeGreaterThan(a.xs[0])
  })

  it('reset：清 carryover 与时钟锚点（新流新时基）', () => {
    const p = new TextLineParser(() => wire())
    p.ingest(enc('1.'), 9000) // 半截行 + 无采样
    p.reset()
    const r = p.ingest(enc('2\n'), 1000)
    expect(r.perChannel[0]).toEqual([2]) // carryover 已清，'2' 独立成行
    expect(r.xs[0]).toBeCloseTo(1000 + 2 * BYTE_MS, 9) // 锚点未被旧流拖住
  })
})
