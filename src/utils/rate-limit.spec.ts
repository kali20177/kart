import { describe, it, expect } from 'vitest'
import { paceDelay } from './rate-limit'

describe('paceDelay', () => {
  it('bps=0 时退化为固定包间延时', () => {
    expect(paceDelay(1000, 0, 0, 0, 50)).toBe(50)
  })

  it('未超前（sent <= 理论值）时等待包间延时', () => {
    // 100ms 已过，bps=1000 → 理论 100 字节，sent=50 未超前
    expect(paceDelay(100, 0, 50, 1000, 10)).toBe(10)
  })

  it('超前时按缺口/速率计算等待，且不低于包间延时', () => {
    // 100ms 已过，bps=1000 → 理论 100 字节，sent=200 超前 100 → 等 100ms
    expect(paceDelay(100, 0, 200, 1000, 10)).toBe(100)
  })

  it('超大幅度超前按比率放大等待', () => {
    // 1000ms 已过，bps=1000 → 理论 1000 字节，sent=2000 超前 1000 → 等 1000ms
    expect(paceDelay(1000, 0, 2000, 1000, 0)).toBe(1000)
  })
})