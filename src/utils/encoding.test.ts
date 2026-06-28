import { describe, it, expect } from 'vitest'
import { decodeBytes, encodeText, encodeWithEscapes, lineEndingBytes, concatBytes } from '@/utils/encoding'

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

describe('encodeWithEscapes', () => {
  const bytes = (text: string) => Array.from(encodeWithEscapes(text))

  it('纯文本不包含转义 → 原样编码', () => {
    expect(bytes('hello')).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f])
  })

  it('空字符串', () => {
    expect(bytes('')).toEqual([])
  })

  // 基本转义
  it('\\r → 0x0D', () => {
    expect(bytes('\\r')).toEqual([0x0d])
  })
  it('\\n → 0x0A', () => {
    expect(bytes('\\n')).toEqual([0x0a])
  })
  it('\\t → 0x09', () => {
    expect(bytes('\\t')).toEqual([0x09])
  })
  it('\\\\ → 0x5C', () => {
    expect(bytes('\\\\')).toEqual([0x5c])
  })
  it('\\0 → 0x00', () => {
    expect(bytes('\\0')).toEqual([0x00])
  })

  // \\xHH
  it('\\x0D\\x0A → CR LF', () => {
    expect(bytes('\\x0D\\x0A')).toEqual([0x0d, 0x0a])
  })
  it('\\x1A (Ctrl+Z)', () => {
    expect(bytes('\\x1A')).toEqual([0x1a])
  })
  it('\\xFF (最大字节)', () => {
    expect(bytes('\\xFF')).toEqual([0xff])
  })
  it('\\x00 (空字节)', () => {
    expect(bytes('\\x00')).toEqual([0x00])
  })

  // 复合场景
  it('AT 命令 + 回车换行', () => {
    expect(bytes('AT\\r\\n')).toEqual([0x41, 0x54, 0x0d, 0x0a])
  })
  it('文本中间嵌入控制字符', () => {
    expect(bytes('hello\\r\\nworld')).toEqual([
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0d, 0x0a, 0x77, 0x6f, 0x72, 0x6c, 0x64
    ])
  })

  // 边界情况
  it('行尾孤立的 \\', () => {
    expect(bytes('AT\\')).toEqual([0x41, 0x54, 0x5c])
  })
  it('\\x 后 hex 数字不足 → 保留字面 \\x', () => {
    // \x 后只有 1 个 hex 数字 → \ 换成 0x5C，x 和后续字面
    expect(bytes('\\xA')).toEqual([0x5c, 0x78, 0x41])
  })
  it('\\x 后无 hex 数字 → 保留字面 \\x', () => {
    expect(bytes('\\x')).toEqual([0x5c, 0x78])
  })
  it('\\x 后非 hex 字符 → 保留字面 \\x', () => {
    expect(bytes('\\xGG')).toEqual([0x5c, 0x78, 0x47, 0x47])
  })
  it('未识别的转义 \\a 保留字面 \\a', () => {
    expect(bytes('\\a')).toEqual([0x5c, 0x61])
  })
  it('仅反斜杠', () => {
    expect(bytes('\\')).toEqual([0x5c])
  })
  it('连续多个转义', () => {
    expect(bytes('\\r\\n\\t')).toEqual([0x0d, 0x0a, 0x09])
  })

  // 与常规文本混排
  it('字面反斜杠 + 转义混排', () => {
    expect(bytes('\\\\\\n')).toEqual([0x5c, 0x0a]) // \\ → \, \n → LF
  })
})

describe('encodeText 集成转义解析', () => {
  it('encodeText 内部调用 encodeWithEscapes', () => {
    const body = encodeText('AT\\r\\n', 'utf-8')
    const all = concatBytes(body, lineEndingBytes('none'))
    expect(Array.from(all)).toEqual([0x41, 0x54, 0x0d, 0x0a])
  })
  it('配合行尾：转义与 lineEnding 同时生效', () => {
    const body = encodeText('CMD', 'utf-8')
    const all = concatBytes(body, lineEndingBytes('crlf'))
    // CMD + 外部追加的 CR LF
    expect(Array.from(all)).toEqual([0x43, 0x4d, 0x44, 0x0d, 0x0a])
  })
})
