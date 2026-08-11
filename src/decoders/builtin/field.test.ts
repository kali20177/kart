import { describe, it, expect } from 'vitest'
import { fieldDecoder } from './field'
import type { FieldDecoderOptions } from '../types'

/** 默认测试配置：AA 55 帧头的常见布局 */
function opts(over: Partial<FieldDecoderOptions> = {}): FieldDecoderOptions {
  return {
    fields: [
      { name: 'hdr', length: 2, format: 'hex' },
      { name: 'len', length: 1, format: 'u8' },
      { name: 'cmd', length: 1, format: 'u8' },
      { name: 'val', length: 2, format: 'u16be' }
    ],
    ...over
  }
}

describe('field decoder · 字段布局', () => {
  it('按序切片并自动接续偏移', () => {
    const r = fieldDecoder.decode(new Uint8Array([0xaa, 0x55, 0x03, 0x01, 0x00, 0x64]), opts())
    expect(r.matched).toBe(true)
    expect(r.fields?.map((f) => [f.name, f.value, f.offset, f.length])).toEqual([
      ['hdr', 'AA 55', 0, 2],
      ['len', '3', 2, 1],
      ['cmd', '1', 3, 1],
      ['val', '100', 4, 2]
    ])
  })

  it('显式 offset 覆盖自动接续', () => {
    const r = fieldDecoder.decode(new Uint8Array([0x01, 0x02, 0x03, 0x04]), {
      fields: [
        { name: 'a', length: 1, format: 'u8' },
        { name: 'b', offset: 3, length: 1, format: 'u8' }
      ]
    })
    expect(r.matched).toBe(true)
    expect(r.fields?.map((f) => [f.offset, f.value])).toEqual([[0, '1'], [3, '4']])
  })

  it('u16le / u32be 取值正确', () => {
    const r = fieldDecoder.decode(new Uint8Array([0x34, 0x12, 0x78, 0x56, 0x34, 0x12]), {
      fields: [
        { name: 'a', length: 2, format: 'u16le' },
        { name: 'b', length: 4, format: 'u32be' }
      ]
    })
    expect(r.fields?.map((f) => f.value)).toEqual(['4660', '2018915346']) // 0x1234 / 0x78563412
  })

  it('ascii / utf8 字段解码', () => {
    const r = fieldDecoder.decode(new Uint8Array([0x48, 0x69, 0x21]), {
      fields: [{ name: 's', length: 3, format: 'ascii' }]
    })
    expect(r.matched).toBe(true)
    expect(r.fields?.[0].value).toBe('Hi!')
  })
})

describe('field decoder · 匹配门槛', () => {
  it('header 前缀不匹配 → matched false', () => {
    const r = fieldDecoder.decode(new Uint8Array([0xbb, 0x55, 0x03, 0x01, 0x00, 0x64]), opts({ header: 'AA55' }))
    expect(r.matched).toBe(false)
  })

  it('header 匹配 → matched true', () => {
    const r = fieldDecoder.decode(new Uint8Array([0xaa, 0x55, 0x03, 0x01, 0x00, 0x64]), opts({ header: 'AA55' }))
    expect(r.matched).toBe(true)
  })

  it('帧长不足任一字段 → matched false', () => {
    const r = fieldDecoder.decode(new Uint8Array([0xaa, 0x55, 0x03]), opts())
    expect(r.matched).toBe(false)
  })

  it('空字段布局 → matched false', () => {
    expect(fieldDecoder.decode(new Uint8Array([1]), { fields: [] }).matched).toBe(false)
  })

  it('非法字段定义（缺名/零长度）→ matched false，不渲染脏数据', () => {
    expect(fieldDecoder.decode(new Uint8Array([1, 2]), { fields: [{ name: '', length: 1, format: 'u8' }] }).matched).toBe(false)
    expect(fieldDecoder.decode(new Uint8Array([1, 2]), { fields: [{ name: 'x', length: 0, format: 'u8' }] }).matched).toBe(false)
  })

  it('length 小于格式最小字节数 → matched false，不抛 RangeError（DataView 越界）', () => {
    // u16 需 2 字节、u32 需 4 字节；length 不足时不应崩管线，返回不匹配
    expect(fieldDecoder.decode(new Uint8Array([0x12, 0x34]), { fields: [{ name: 'x', length: 1, format: 'u16be' }] }).matched).toBe(false)
    expect(fieldDecoder.decode(new Uint8Array([0x12, 0x34]), { fields: [{ name: 'x', length: 1, format: 'u16le' }] }).matched).toBe(false)
    expect(fieldDecoder.decode(new Uint8Array([0x12, 0x34, 0x56]), { fields: [{ name: 'x', length: 3, format: 'u32le' }] }).matched).toBe(false)
    // 最小字节数恰好满足则正常解析
    const ok = fieldDecoder.decode(new Uint8Array([0x12, 0x34]), { fields: [{ name: 'x', length: 2, format: 'u16be' }] })
    expect(ok.matched).toBe(true)
    expect(ok.fields?.[0].value).toBe('4660')
  })
})
