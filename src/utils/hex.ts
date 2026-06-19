// HEX 输入解析与显示格式化

/** 解析结果 */
export interface HexParseResult {
  ok: boolean
  bytes: Uint8Array
  /** 错误信息（ok=false 时有效） */
  error?: string
  /** 被剔除的非法字符（用于提示） */
  stripped?: string
}

/**
 * 解析用户输入的 hex 字符串，宽容地接受多种分隔格式：
 *   "0A FF"、"0a,ff"、"0xAA 0xBB"、"aabbcc"、"0x0A 0x0D"
 * 规则：
 *   - 先去掉 "0x"/"0X" 前缀标记
 *   - 剔除所有非 [0-9a-fA-F] 字符（空格、逗号、换行等都作分隔符）
 *   - 拼成连续 hex 串后，要求长度为偶数
 */
export function parseHexInput(input: string): HexParseResult {
  // 移除 0x / 0X 前缀（作为标记，不作为数据）
  const withoutPrefix = input.replace(/0[xX]/g, ' ')
  // 找出非 hex、非分隔符的"可疑"字符用于提示（分隔符 = 空格/逗号/制表/换行/分号/冒号/连字符）
  const stripped = withoutPrefix.replace(/[0-9a-fA-F\s,;:_-]/g, '')
  // 仅保留 hex 字符
  const clean = withoutPrefix.replace(/[^0-9a-fA-F]/g, '')

  if (clean.length === 0) {
    return { ok: false, bytes: new Uint8Array(0), error: '没有有效的十六进制字符' }
  }
  if (clean.length % 2 !== 0) {
    return {
      ok: false,
      bytes: new Uint8Array(0),
      error: `十六进制字符数为奇数（${clean.length}），无法成字节`,
      stripped: stripped || undefined
    }
  }

  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return { ok: true, bytes, stripped: stripped || undefined }
}

/** 字节数组转空格分隔的大写 hex 字符串："AA 55 01" */
export function bytesToHex(bytes: Uint8Array, separator = ' '): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, '0').toUpperCase())
  }
  return parts.join(separator)
}

/** HEX 视图的一行 */
export interface HexDumpLine {
  /** 偏移地址，如 "0000" */
  offset: string
  /** 该行的 hex 字节（已补足空位用于对齐） */
  hex: string
  /** 该行的 ASCII 透视（不可打印用 '.'） */
  ascii: string
}

/**
 * 生成类似 hexdump 的多行视图：每行 bytesPerLine 字节，
 * 左侧 hex、右侧 ASCII 透视列。用于气泡 HEX 模式。
 */
export function hexDump(bytes: Uint8Array, bytesPerLine = 16): HexDumpLine[] {
  const lines: HexDumpLine[] = []
  for (let off = 0; off < bytes.length; off += bytesPerLine) {
    const slice = bytes.subarray(off, off + bytesPerLine)
    const hexParts: string[] = []
    let ascii = ''
    for (let i = 0; i < bytesPerLine; i++) {
      if (i < slice.length) {
        const b = slice[i]
        hexParts.push(b.toString(16).padStart(2, '0').toUpperCase())
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'
      } else {
        hexParts.push('  ') // 占位对齐
      }
    }
    lines.push({
      offset: off.toString(16).padStart(4, '0').toUpperCase(),
      hex: hexParts.join(' '),
      ascii
    })
  }
  return lines
}
