import { describe, expect, it } from 'vitest'
import { estimateJsonSize } from './size'

describe('estimateJsonSize', () => {
  it('returns stringified length for plain values', () => {
    expect(estimateJsonSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    expect(estimateJsonSize([1, 2, 3])).toBe(JSON.stringify([1, 2, 3]).length)
    expect(estimateJsonSize('hello')).toBe(7)
    expect(estimateJsonSize(null)).toBe(4)
  })

  it('returns 0 for non-serializable values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(estimateJsonSize(circular)).toBe(0)
  })
})
