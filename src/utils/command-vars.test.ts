import { describe, it, expect } from 'vitest'
import { expandCommandVars, formatHms, formatFull } from './command-vars'

// 构造本地时间：new Date(y,m,d,h,min,s) 永远得到该本地墙钟时间，
// formatHms/formatFull 读本地分量，断言不受运行机时区影响。
const NOW = new Date(2026, 7, 17, 9, 5, 7) // 2026-08-17 09:05:07

describe('formatHms / formatFull', () => {
  it('HH:MM:SS 补零', () => {
    expect(formatHms(NOW)).toBe('09:05:07')
    expect(formatHms(new Date(2026, 0, 1, 0, 0, 0))).toBe('00:00:00')
  })
  it('YYYY-MM-DD HH:MM:SS', () => {
    expect(formatFull(NOW)).toBe('2026-08-17 09:05:07')
    expect(formatFull(new Date(2026, 11, 3, 23, 59, 59))).toBe('2026-12-03 23:59:59')
  })
})

describe('expandCommandVars', () => {
  it('无占位符原样返回', () => {
    expect(expandCommandVars('AT+CSQ', 'ascii', { now: NOW })).toBe('AT+CSQ')
    expect(expandCommandVars('', 'ascii', { now: NOW })).toBe('')
  })

  it('{time} ascii → HH:MM:SS', () => {
    expect(expandCommandVars('SET 09:00 {time}', 'ascii', { now: NOW })).toBe('SET 09:00 09:05:07')
  })

  it('{time} hex → ASCII 十六进制', () => {
    // "09:05:07" 逐字节 30 39 3A 30 35 3A 30 37
    expect(expandCommandVars('{time}', 'hex', { now: NOW })).toBe('30393A30353A3037')
  })

  it('{time:full} ascii → YYYY-MM-DD HH:MM:SS', () => {
    expect(expandCommandVars('{time:full}', 'ascii', { now: NOW })).toBe('2026-08-17 09:05:07')
  })

  it('{time:full} hex → ASCII 十六进制', () => {
    expect(expandCommandVars('{time:full}', 'hex', { now: NOW })).toBe('323032362D30382D31372030393A30353A3037')
  })

  it('{seq} ascii → 十进制', () => {
    expect(expandCommandVars('{seq}', 'ascii', { now: NOW, seq: 1 })).toBe('1')
    expect(expandCommandVars('{seq}', 'ascii', { now: NOW, seq: 42 })).toBe('42')
  })

  it('{seq} hex → 单字节大写 hex，>255 取模', () => {
    expect(expandCommandVars('{seq}', 'hex', { now: NOW, seq: 1 })).toBe('01')
    expect(expandCommandVars('AA 55 {seq} 03', 'hex', { now: NOW, seq: 5 })).toBe('AA 55 05 03')
    expect(expandCommandVars('{seq}', 'hex', { now: NOW, seq: 255 })).toBe('FF')
    expect(expandCommandVars('{seq}', 'hex', { now: NOW, seq: 256 })).toBe('00')
    expect(expandCommandVars('{seq}', 'hex', { now: NOW, seq: 257 })).toBe('01')
  })

  it('{seq} 默认 ctx.seq=1', () => {
    expect(expandCommandVars('{seq}', 'ascii', { now: NOW })).toBe('1')
  })

  it('{rand} ascii → 十进制 0-255', () => {
    expect(expandCommandVars('{rand}', 'ascii', { now: NOW, random: () => 0 })).toBe('0')
    expect(expandCommandVars('{rand}', 'ascii', { now: NOW, random: () => 0.9999 })).toBe('255')
    expect(expandCommandVars('{rand}', 'ascii', { now: NOW, random: () => 0.5 })).toBe('128')
  })

  it('{rand} hex → 单字节大写 hex', () => {
    expect(expandCommandVars('{rand}', 'hex', { now: NOW, random: () => 0.5 })).toBe('80')
    expect(expandCommandVars('{rand}', 'hex', { now: NOW, random: () => 0 })).toBe('00')
  })

  it('多占位符一次展开', () => {
    const out = expandCommandVars('{seq}-{seq}', 'ascii', { now: NOW, seq: 3 })
    expect(out).toBe('3-3')
  })

  it('未知占位符原样保留', () => {
    expect(expandCommandVars('AA {foo} BB', 'hex', { now: NOW })).toBe('AA {foo} BB')
  })

  it('大小写不敏感', () => {
    expect(expandCommandVars('{TIME}', 'ascii', { now: NOW })).toBe('09:05:07')
    expect(expandCommandVars('{Seq}', 'ascii', { now: NOW, seq: 7 })).toBe('7')
  })
})