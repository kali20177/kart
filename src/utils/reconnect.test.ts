import { describe, it, expect } from 'vitest'
import { shouldReconnect, countdownSecs } from './reconnect'

describe('shouldReconnect', () => {
  it('开关关闭 → 不排程（disabled）', () => {
    expect(shouldReconnect(false, false, 'COM5')).toEqual({ schedule: false, reason: 'disabled' })
  })

  it('已连接 → 不排程（connected，避免重连覆盖活跃连接）', () => {
    expect(shouldReconnect(true, true, 'COM5')).toEqual({ schedule: false, reason: 'connected' })
  })

  it('无上次端口 → 不排程（no-port，需用户重新选端口）', () => {
    expect(shouldReconnect(true, false, null)).toEqual({ schedule: false, reason: 'no-port' })
    expect(shouldReconnect(true, false, '')).toEqual({ schedule: false, reason: 'no-port' })
  })

  it('开启 + 断开 + 有端口 → 排程', () => {
    expect(shouldReconnect(true, false, 'COM5')).toEqual({ schedule: true })
  })

  it('开关优先级最高：即便无端口也报 disabled 而非 no-port', () => {
    expect(shouldReconnect(false, false, null)).toEqual({ schedule: false, reason: 'disabled' })
  })
})

describe('countdownSecs', () => {
  it('nextAt 为 null → 0', () => {
    expect(countdownSecs(1000, null)).toBe(0)
  })

  it('now 已过 nextAt → 0（立即重试）', () => {
    expect(countdownSecs(5000, 5000)).toBe(0)
    expect(countdownSecs(5300, 5000)).toBe(0)
  })

  it('向上取整到整秒', () => {
    expect(countdownSecs(4000, 5000)).toBe(1) // 1000ms → 1s
    expect(countdownSecs(3500, 5000)).toBe(2) // 1500ms → 2s
    expect(countdownSecs(4000, 6050)).toBe(3) // 2050ms → 3s
  })
})