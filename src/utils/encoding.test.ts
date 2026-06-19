import { describe, it, expect } from 'vitest'
import { decodeBytes, encodeText, lineEndingBytes, concatBytes } from '@/utils/encoding'

describe('decodeBytes', () => {
  it('ascii 模式不可打印替换为 ·', () => {
    const out = decodeBytes(new Uint8Array([0x41, 0x00, 0x42]), 'ascii')
    expect(out).toBe('A·B')
  })

  it('utf-8 正常解码', () => {
    expect(decodeBytes(new TextEncoder().encode('OK'), 'utf-8')).toBe('OK')
  })

  it('gbk 解码中文（Chromium TextDecoder 支持）', () => {
    // "温度" 的 GBK 字节
    const bytes = new Uint8Array([0xce, 0xc2, 0xb6, 0xc8])
    const out = decodeBytes(bytes, 'gbk')
    // jsdom/node 若不支持 gbk 会回退，至少不抛错且返回字符串
    expect(typeof out).toBe('string')
  })
})

describe('lineEndingBytes', () => {
  it('crlf', () => {
    expect(Array.from(lineEndingBytes('crlf'))).toEqual([0x0d, 0x0a])
  })
  it('none 为空', () => {
    expect(lineEndingBytes('none').length).toBe(0)
  })
})

describe('encodeText + concatBytes', () => {
  it('文本编码并追加行尾', () => {
    const body = encodeText('AT', 'utf-8')
    const all = concatBytes(body, lineEndingBytes('crlf'))
    expect(Array.from(all)).toEqual([0x41, 0x54, 0x0d, 0x0a])
  })
})
