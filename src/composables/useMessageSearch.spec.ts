import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useMessageSearch } from '@/composables/useMessageSearch'
import type { Encoding, Message } from '@/types'

let seq = 0
function msg(direction: 'rx' | 'tx', bytes: number[], time: { h: number; m: number; s?: number; ms?: number }): Message {
  const d = new Date(2026, 0, 1, time.h, time.m, time.s ?? 0, time.ms ?? 0)
  return { id: ++seq, direction, bytes: new Uint8Array(bytes), timestamp: d.getTime() }
}

function divider(note: string, time: { h: number; m: number; s?: number; ms?: number }): Message {
  const d = new Date(2026, 0, 1, time.h, time.m, time.s ?? 0, time.ms ?? 0)
  return { id: ++seq, direction: 'tx', bytes: new Uint8Array(0), timestamp: d.getTime(), kind: 'divider', note: note || undefined }
}

// seq 为模块级计数器，每条用例前重置，保证 id 从 1 开始且不跨用例累积
beforeEach(() => {
  seq = 0
})

function mount(messages: Message[], opts: {
  keyword?: string
  searchMode?: 'text' | 'hex'
  encoding?: Encoding
  dirFilter?: 'all' | 'rx' | 'tx'
  timeStart?: number | null
  timeEnd?: number | null
  hasNote?: boolean
}) {
  const r = useMessageSearch({
    messages: ref(messages),
    keyword: ref(opts.keyword ?? ''),
    searchMode: ref(opts.searchMode ?? 'text'),
    encoding: ref(opts.encoding ?? 'utf-8'),
    dirFilter: ref(opts.dirFilter ?? 'all'),
    timeStart: ref(opts.timeStart ?? null),
    timeEnd: ref(opts.timeEnd ?? null),
    hasNote: ref(opts.hasNote ?? false)
  })
  return r
}

describe('useMessageSearch — 文本搜索', () => {
  it('按关键字过滤并给出字符偏移区间', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('OK')), { h: 10, m: 0 }),
      msg('rx', Array.from(enc.encode('hello')), { h: 10, m: 1 }),
      msg('rx', Array.from(enc.encode('OK')), { h: 10, m: 2 })
    ]
    const r = mount(ms, { keyword: 'ok' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1, 3])
    expect(r.matchCount.value).toBe(2)
    expect(r.matchRanges.value.get(1)).toEqual([{ start: 0, end: 2 }])
    expect(r.hexError.value).toBeNull()
  })

  it('重叠命中合并后再返回区间', () => {
    const enc = new TextEncoder()
    // "aaa" 搜 "aa" → [0,2],[1,3] 合并为 [0,3]
    const ms = [msg('rx', Array.from(enc.encode('aaa')), { h: 10, m: 0 })]
    const r = mount(ms, { keyword: 'aa' })
    expect(r.matchRanges.value.get(1)).toEqual([{ start: 0, end: 3 }])
  })

  it('空关键字：不匹配但不过滤，matchCount=0', () => {
    const ms = [msg('rx', [0x41], { h: 10, m: 0 }), msg('tx', [0x42], { h: 10, m: 1 })]
    const r = mount(ms, { keyword: '' })
    expect(r.filtered.value.length).toBe(2)
    expect(r.matchCount.value).toBe(0)
    expect(r.matchRanges.value.size).toBe(0)
  })
})

describe('useMessageSearch — HEX 搜索', () => {
  it('按字节序列过滤并给出字节偏移区间', () => {
    const ms = [
      msg('rx', [0xaa, 0x55, 0x01], { h: 10, m: 0 }),
      msg('rx', [0x00, 0xaa, 0x55, 0x02], { h: 10, m: 1 }),
      msg('rx', [0xff, 0xee], { h: 10, m: 2 })
    ]
    const r = mount(ms, { keyword: 'AA 55', searchMode: 'hex' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1, 2])
    expect(r.matchCount.value).toBe(2)
    expect(r.matchRanges.value.get(1)).toEqual([{ start: 0, end: 2 }])
    expect(r.matchRanges.value.get(2)).toEqual([{ start: 1, end: 3 }])
    expect(r.hexError.value).toBeNull()
  })

  it('解析失败：hexError 非空、不按关键字过滤、matchCount=0', () => {
    const ms = [msg('rx', [0xaa, 0x55], { h: 10, m: 0 }), msg('rx', [0x01], { h: 10, m: 1 })]
    const r = mount(ms, { keyword: 'AAB', searchMode: 'hex' })
    expect(r.hexError.value).toContain('奇数')
    // 解析失败 → 不按关键字过滤，全部显示
    expect(r.filtered.value.length).toBe(2)
    expect(r.matchCount.value).toBe(0)
    expect(r.matchRanges.value.size).toBe(0)
  })

  it('接受多种分隔格式', () => {
    const ms = [msg('rx', [0x0d, 0x0a], { h: 10, m: 0 })]
    const r = mount(ms, { keyword: '0x0D,0x0A', searchMode: 'hex' })
    expect(r.matchCount.value).toBe(1)
    expect(r.matchRanges.value.get(1)).toEqual([{ start: 0, end: 2 }])
  })
})

describe('useMessageSearch — 方向 + 时间过滤', () => {
  it('方向过滤', () => {
    const ms = [msg('rx', [0x01], { h: 10, m: 0 }), msg('tx', [0x02], { h: 10, m: 1 })]
    const r = mount(ms, { dirFilter: 'tx' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([2])
  })

  it('时间区间过滤（当日毫秒数）', () => {
    const ms = [
      msg('rx', [0x01], { h: 10, m: 30, s: 0 }),
      msg('rx', [0x02], { h: 10, m: 35, s: 0 }),
      msg('rx', [0x03], { h: 11, m: 0, s: 0 })
    ]
    const t0 = 10 * 3600000 + 30 * 60000 // 10:30:00
    const t1 = 10 * 3600000 + 40 * 60000 // 10:40:00
    const r = mount(ms, { timeStart: t0, timeEnd: t1 })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1, 2])
  })

  it('单边时间区间（仅 start）', () => {
    const ms = [
      msg('rx', [0x01], { h: 10, m: 0 }),
      msg('rx', [0x02], { h: 11, m: 0 })
    ]
    const t0 = 10 * 3600000 + 30 * 60000 // 10:30:00
    const r = mount(ms, { timeStart: t0 })
    expect(r.filtered.value.map((m) => m.id)).toEqual([2])
  })

  it('方向 + 时间 + 关键字组合', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('OK')), { h: 10, m: 30 }),
      msg('tx', Array.from(enc.encode('OK')), { h: 10, m: 31 }),
      msg('rx', Array.from(enc.encode('OK')), { h: 11, m: 0 })
    ]
    const r = mount(ms, {
      keyword: 'ok',
      dirFilter: 'rx',
      timeStart: 10 * 3600000,
      timeEnd: 10 * 3600000 + 59 * 60000
    })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1])
    expect(r.matchCount.value).toBe(1)
  })
})

describe('useMessageSearch — 按标注筛选', () => {
  it('hasNote=true 仅保留带标注的普通帧', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('A')), { h: 10, m: 0 }),
      msg('rx', Array.from(enc.encode('B')), { h: 10, m: 1, ms: 0 })
    ]
    // 第二条加标注
    ms[1].note = 'mark'
    const r = mount(ms, { hasNote: true })
    expect(r.filtered.value.map((m) => m.id)).toEqual([2])
  })

  it('hasNote=true 时分隔线作为结构标记始终保留（不带标注的亦保留）', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('A')), { h: 10, m: 0 }),
      divider('', { h: 10, m: 1 }) // 无标签分隔线
    ]
    const r = mount(ms, { hasNote: true })
    // 分隔线是结构标记，不受"按标注筛选"约束
    expect(r.filtered.value.map((m) => m.id)).toEqual([2])
  })
})

describe('useMessageSearch — 分隔线不受方向过滤', () => {
  it('dirFilter=rx 仍保留分隔线（即便 direction=tx）', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('A')), { h: 10, m: 0 }),
      divider('mark', { h: 10, m: 1 }),
      msg('tx', Array.from(enc.encode('B')), { h: 10, m: 2 })
    ]
    const r = mount(ms, { dirFilter: 'rx' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1, 2])
  })

  it('dirFilter=tx 仍保留分隔线', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('A')), { h: 10, m: 0 }),
      divider('mark', { h: 10, m: 1 }),
      msg('tx', Array.from(enc.encode('B')), { h: 10, m: 2 })
    ]
    const r = mount(ms, { dirFilter: 'tx' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([2, 3])
  })

  it('关键字过滤时分隔线始终可见', () => {
    const enc = new TextEncoder()
    const ms = [
      msg('rx', Array.from(enc.encode('OK')), { h: 10, m: 0 }),
      divider('section', { h: 10, m: 1 }),
      msg('rx', Array.from(enc.encode('NX')), { h: 10, m: 2 })
    ]
    const r = mount(ms, { keyword: 'ok' })
    expect(r.filtered.value.map((m) => m.id)).toEqual([1, 2])
  })
})
