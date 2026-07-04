import { describe, it, expect } from 'vitest'
import { findTextRanges, mergeRanges, timeOfDay, parseTimeInput } from '@/utils/search'

describe('findTextRanges', () => {
  it('空关键字返回空数组', () => {
    expect(findTextRanges('abc', '')).toEqual([])
  })

  it('无命中返回空数组', () => {
    expect(findTextRanges('hello world', 'xyz')).toEqual([])
  })

  it('单命中', () => {
    expect(findTextRanges('hello', 'll')).toEqual([{ start: 2, end: 4 }])
  })

  it('多命中（不重叠）', () => {
    expect(findTextRanges('ab ab ab', 'ab')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 }
    ])
  })

  it('重叠命中（aaaa 搜 aa → 0、1、2）', () => {
    expect(findTextRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 2, end: 4 }
    ])
  })

  it('大小写不敏感', () => {
    expect(findTextRanges('Ok OK oK', 'ok')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 }
    ])
  })
})

describe('mergeRanges', () => {
  it('空数组返回空', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('单个区间原样返回（副本）', () => {
    expect(mergeRanges([{ start: 1, end: 3 }])).toEqual([{ start: 1, end: 3 }])
  })

  it('合并相交区间', () => {
    // [0,2],[1,3],[2,4] → [0,4]
    expect(
      mergeRanges([
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 2, end: 4 }
      ])
    ).toEqual([{ start: 0, end: 4 }])
  })

  it('合并相邻区间（cur.start === last.end）', () => {
    expect(
      mergeRanges([
        { start: 0, end: 2 },
        { start: 2, end: 4 }
      ])
    ).toEqual([{ start: 0, end: 4 }])
  })

  it('保留不相交区间（先排序）', () => {
    expect(
      mergeRanges([
        { start: 5, end: 7 },
        { start: 0, end: 2 },
        { start: 9, end: 10 }
      ])
    ).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 9, end: 10 }
    ])
  })

  it('被包含的区间不缩小右端', () => {
    // [0,5] 已包含 [1,3] → 仍为 [0,5]
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 1, end: 3 }
      ])
    ).toEqual([{ start: 0, end: 5 }])
  })
})

describe('timeOfDay', () => {
  it('由时间戳算当日毫秒数', () => {
    // 2026-01-01 10:30:45.250（UTC+0 构造，本地时区不影响小时提取）
    const d = new Date(2026, 0, 1, 10, 30, 45, 250)
    expect(timeOfDay(d.getTime())).toBe(10 * 3600000 + 30 * 60000 + 45 * 1000 + 250)
  })

  it('零点为 0', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0, 0)
    expect(timeOfDay(d.getTime())).toBe(0)
  })
})

describe('parseTimeInput', () => {
  it('HH:MM:SS', () => {
    expect(parseTimeInput('10:30:45')).toBe(10 * 3600000 + 30 * 60000 + 45 * 1000)
  })

  it('HH:MM:SS.mmm', () => {
    expect(parseTimeInput('10:30:45.250')).toBe(10 * 3600000 + 30 * 60000 + 45 * 1000 + 250)
  })

  it('HH:MM:SS.m（毫秒不足 3 位补零）', () => {
    expect(parseTimeInput('10:30:45.2')).toBe(10 * 3600000 + 30 * 60000 + 45 * 1000 + 200)
  })

  it('HH:MM（省略秒）', () => {
    expect(parseTimeInput('10:30')).toBe(10 * 3600000 + 30 * 60000)
  })

  it('H:MM:SS（单位数小时）', () => {
    expect(parseTimeInput('9:05:00')).toBe(9 * 3600000 + 5 * 60000)
  })

  it('含空格自动 trim', () => {
    expect(parseTimeInput('  10:30:00  ')).toBe(10 * 3600000 + 30 * 60000)
  })

  it('小时越界返回 null', () => {
    expect(parseTimeInput('24:00:00')).toBeNull()
  })

  it('分越界返回 null', () => {
    expect(parseTimeInput('10:60:00')).toBeNull()
  })

  it('秒越界返回 null', () => {
    expect(parseTimeInput('10:30:60')).toBeNull()
  })

  it('格式非法返回 null', () => {
    expect(parseTimeInput('abc')).toBeNull()
    expect(parseTimeInput('10:3')).toBeNull()
    expect(parseTimeInput('10:30:45.1234')).toBeNull()
  })
})
