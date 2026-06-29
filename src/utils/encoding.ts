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

/**
 * 把字符串按编码转为字节（发送 ASCII 内容用）。
 *
 * 支持 C 风格转义序列，方便在 ASCII 模式下嵌入控制字符：
 *   \r  → 0x0D  回车
 *   \n  → 0x0A  换行
 *   \t  → 0x09  制表
 *   \\  → 0x5C  反斜杠
 *   \0  → 0x00  空字节
 *   \xHH → 任意十六进制字节，如 \x1A → 0x1A
 *
 * 未识别的转义（如 \a、行尾孤立的 \）保留原样，不丢数据。
 * 非转义文本统一用 UTF-8 编码（ASCII 字符在 utf-8/gbk/ascii 下编码一致）。
 *
 * 多行输入：输入框里的原始换行（\n / \r）仅为视觉分隔，不会被编码为字节；
 * 如需发送真实换行，请用 \n / \r 转义序列。
 */
export function encodeText(text: string, encoding: Encoding): Uint8Array {
  void encoding
  return encodeWithEscapes(text)
}

/** 判断字符是否为十六进制数字 */
function isHexChar(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/**
 * 解析 C 风格转义序列并编码为字节。
 * 暴露为独立函数以便调用方做发送前预览。
 */
export function encodeWithEscapes(text: string): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  let literalStart = 0
  let i = 0

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      // 把前面的字面文本刷入
      if (literalStart < i) {
        parts.push(encoder.encode(text.slice(literalStart, i)))
      }

      const next = text[i + 1]
      let consumed = 2 // 默认消费反斜杠 + 下一字符

      switch (next) {
        case 'r':
          parts.push(new Uint8Array([0x0d]))
          break
        case 'n':
          parts.push(new Uint8Array([0x0a]))
          break
        case 't':
          parts.push(new Uint8Array([0x09]))
          break
        case '0':
          parts.push(new Uint8Array([0x00]))
          break
        case '\\':
          parts.push(new Uint8Array([0x5c]))
          break
        case 'x': {
          // \xHH —— 要求恰好 2 个十六进制数字
          if (i + 3 < text.length && isHexChar(text[i + 2]) && isHexChar(text[i + 3])) {
            const byte = parseInt(text.slice(i + 2, i + 4), 16)
            parts.push(new Uint8Array([byte]))
            consumed = 4
          } else {
            // \x 后 hex 数字不足 → 保留字面反斜杠，x 及之后按字面处理
            parts.push(new Uint8Array([0x5c]))
            consumed = 1
          }
          break
        }
        default:
          // 未识别的转义 → 只消费反斜杠，后续字符回归字面
          parts.push(new Uint8Array([0x5c]))
          consumed = 1
      }

      i += consumed
      literalStart = i
    } else if (text[i] === '\\' && i + 1 >= text.length) {
      // 行尾孤立的 \ → 字面反斜杠
      if (literalStart < i) {
        parts.push(encoder.encode(text.slice(literalStart, i)))
      }
      parts.push(new Uint8Array([0x5c]))
      i++
      literalStart = i
    } else if (text[i] === '\n' || text[i] === '\r') {
      // 多行输入框里的原始换行仅为视觉分隔，不产生任何字节；
      // 若需发送真实的换行/回车，请用 \n / \r 转义序列。
      if (literalStart < i) {
        parts.push(encoder.encode(text.slice(literalStart, i)))
      }
      i++
      literalStart = i
    } else {
      i++
    }
  }

  // 刷入剩余字面文本
  if (literalStart < text.length) {
    parts.push(encoder.encode(text.slice(literalStart)))
  }

  return concatBytes(...parts)
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
