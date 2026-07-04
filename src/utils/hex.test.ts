import { describe, it, expect } from 'vitest'
import { parseHexInput, bytesToHex, hexDump, findByteRanges } from '@/utils/hex'

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

describe('findByteRanges', () => {
  it('空 needle 返回空数组', () => {
    expect(findByteRanges(new Uint8Array([0x01, 0x02]), new Uint8Array(0))).toEqual([])
  })

  it('needle 比 haystack 长返回空数组', () => {
    expect(findByteRanges(new Uint8Array([0x01]), new Uint8Array([0x01, 0x02]))).toEqual([])
  })

  it('无匹配返回空数组', () => {
    expect(findByteRanges(new Uint8Array([0x01, 0x02, 0x03]), new Uint8Array([0xff]))).toEqual([])
  })

  it('单匹配', () => {
    expect(
      findByteRanges(new Uint8Array([0x0d, 0x0a, 0x41]), new Uint8Array([0x0d, 0x0a]))
    ).toEqual([{ start: 0, end: 2 }])
  })

  it('多匹配', () => {
    expect(
      findByteRanges(new Uint8Array([0x0d, 0x0a, 0x41, 0x0d, 0x0a]), new Uint8Array([0x0d, 0x0a]))
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
  })

  it('包含重叠匹配', () => {
    // "AAAA" 中搜索 "AA" → 位置 0、1、2
    expect(
      findByteRanges(new Uint8Array([0x41, 0x41, 0x41, 0x41]), new Uint8Array([0x41, 0x41]))
    ).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 2, end: 4 }
    ])
  })

  it('单字节 needle', () => {
    expect(
      findByteRanges(new Uint8Array([0x00, 0x41, 0x00, 0x42, 0x00]), new Uint8Array([0x00]))
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 }
    ])
  })

  it('完整 haystack 匹配', () => {
    expect(
      findByteRanges(new Uint8Array([0x41, 0x42]), new Uint8Array([0x41, 0x42]))
    ).toEqual([{ start: 0, end: 2 }])
  })
})
