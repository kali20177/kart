import { describe, it, expect } from 'vitest'
import { parseHexInput, bytesToHex, hexDump } from '@/utils/hex'

describe('parseHexInput', () => {
  it('解析空格分隔', () => {
    const r = parseHexInput('AA 55 01')
    expect(r.ok).toBe(true)
    expect(Array.from(r.bytes)).toEqual([0xaa, 0x55, 0x01])
  })

  it('解析逗号与 0x 前缀混合', () => {
    const r = parseHexInput('0xAA,0x55 0x01')
    expect(r.ok).toBe(true)
    expect(Array.from(r.bytes)).toEqual([0xaa, 0x55, 0x01])
  })

  it('解析无分隔连续串', () => {
    const r = parseHexInput('aabbcc')
    expect(r.ok).toBe(true)
    expect(Array.from(r.bytes)).toEqual([0xaa, 0xbb, 0xcc])
  })

  it('混合分隔符 "AA 55,01,02 0x03 ff"', () => {
    const r = parseHexInput('AA 55,01,02 0x03 ff')
    expect(r.ok).toBe(true)
    expect(bytesToHex(r.bytes)).toBe('AA 55 01 02 03 FF')
  })

  it('奇数长度报错', () => {
    const r = parseHexInput('AAB')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('奇数')
  })

  it('全非法字符报错（无任何 hex 字符）', () => {
    const r = parseHexInput('zzz ghi!!')
    expect(r.ok).toBe(false)
  })
})

describe('bytesToHex', () => {
  it('大写空格分隔', () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0xff]))).toBe('0A FF')
  })
})

describe('hexDump', () => {
  it('每 16 字节一行，含 ASCII 透视', () => {
    const bytes = new Uint8Array(20).map((_, i) => i + 0x41)
    const lines = hexDump(bytes, 16)
    expect(lines.length).toBe(2)
    expect(lines[0].offset).toBe('0000')
    expect(lines[0].ascii).toBe('ABCDEFGHIJKLMNOP')
    expect(lines[1].offset).toBe('0010')
  })

  it('不可打印字节显示为点', () => {
    const lines = hexDump(new Uint8Array([0x00, 0x41, 0xff]), 16)
    expect(lines[0].ascii).toBe('.A.')
  })
})
