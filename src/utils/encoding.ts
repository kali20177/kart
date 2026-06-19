import type { Encoding, LineEnding } from '@/types'

/**
 * 把字节按指定编码解码为可显示字符串（ASCII 视图用）。
 * - utf-8 / gbk：用浏览器内置 TextDecoder（Chromium 原生支持 gbk 这类 legacy 编码）
 * - ascii：仅 0x20-0x7e 可打印，其余替换为 '·'
 * 不可解码 / 不可打印的字节统一以可见占位符呈现，避免吞数据。
 */
export function decodeBytes(bytes: Uint8Array, encoding: Encoding): string {
  if (encoding === 'ascii') {
    let out = ''
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
    }
    return out
  }
  try {
    // fatal:false → 非法序列用 U+FFFD 替换，不抛错
    const decoder = new TextDecoder(encoding, { fatal: false })
    return decoder.decode(bytes)
  } catch {
    // 个别环境不支持 gbk 时回退到 ascii 呈现
    return decodeBytes(bytes, 'ascii')
  }
}

/** 把字符串按编码转为字节（发送 ASCII 内容用） */
export function encodeText(text: string, encoding: Encoding): Uint8Array {
  // TextEncoder 仅支持 utf-8；gbk/ascii 的发送在嵌入式调试里极少用非 ASCII 字符，
  // 这里统一用 utf-8 编码（ASCII 字符在 utf-8/gbk/ascii 下编码一致）。
  void encoding
  return new TextEncoder().encode(text)
}

/** 行尾符对应的字节 */
export function lineEndingBytes(ending: LineEnding): Uint8Array {
  switch (ending) {
    case 'cr':
      return new Uint8Array([0x0d])
    case 'lf':
      return new Uint8Array([0x0a])
    case 'crlf':
      return new Uint8Array([0x0d, 0x0a])
    case 'none':
    default:
      return new Uint8Array(0)
  }
}

/** 拼接多个字节数组 */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
