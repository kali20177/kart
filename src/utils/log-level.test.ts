import { describe, it, expect } from 'vitest'
import { LEVEL_ORDER, mapConsoleLevel, formatLogLine } from './log-level'

describe('LEVEL_ORDER', () => {
  it('debug < info < warn < error', () => {
    expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info)
    expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn)
    expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error)
  })
})

describe('mapConsoleLevel', () => {
  // Electron 官方语义：0=verbose 1=info 2=warning 3=error
  it('maps Electron console-message levels', () => {
    expect(mapConsoleLevel(0)).toBe('debug')
    expect(mapConsoleLevel(1)).toBe('info')
    expect(mapConsoleLevel(2)).toBe('warn')
    expect(mapConsoleLevel(3)).toBe('error')
  })

  it('regression: 1 must NOT be warn (历史 bug：1/2 写反)', () => {
    expect(mapConsoleLevel(1)).not.toBe('warn')
    expect(mapConsoleLevel(2)).not.toBe('info')
  })

  it('unknown level falls back to info', () => {
    expect(mapConsoleLevel(99)).toBe('info')
    expect(mapConsoleLevel(-1)).toBe('info')
  })
})

describe('formatLogLine', () => {
  it('formats with uppercased level and trailing newline', () => {
    const line = formatLogLine('2026-07-28T10:00:00.000Z', 'warn', 'serial', 'port lost')
    expect(line).toBe('[2026-07-28T10:00:00.000Z] [WARN] [serial] port lost\n')
  })
})
