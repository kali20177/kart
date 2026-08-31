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

/**
 * 在字节数组中搜索子序列，返回所有匹配的起止区间（start 为字节偏移，end 为 start+needle.length）。
 * 纯字节级比较，不涉及编码；含重叠匹配（如 "AAAA" 搜 "AA" → 0、1、2）。
 * 空 needle 或 needle 比 haystack 长 → 空数组。供 HEX 搜索 / 高亮复用。
 */
export function findByteRanges(
  haystack: Uint8Array,
  needle: Uint8Array
): Array<{ start: number; end: number }> {
  if (needle.length === 0 || needle.length > haystack.length) return []
  const ranges: Array<{ start: number; end: number }> = []
  const limit = haystack.length - needle.length
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    ranges.push({ start: i, end: i + needle.length })
  }
  return ranges
}

/**
 * HEX 输入框实时排版：把任意输入规范成「按字节空格分隔」的大写 hex 串
 * （"aabb cD" → "AA BB CD"），非法字符被剔除。
 * 同时把输入串中的光标位置（或选区终点）映射到格式化串中的对应位置，
 * 供输入后原地恢复光标。
 * opts.stripZeroX（默认 true）控制是否把 "0x"/"0X" 当作标记剔除：粘贴
 * 完整串时与 parseHexInput 语义一致；逐字输入时逐个字符是 hex 校验，
 * "x" 本身是非法字符（被忽略），不应连带擦掉前面的 "0"。
 */
export function formatHexInput(
  input: string,
  caret: number,
  opts: { stripZeroX?: boolean } = {}
): { value: string; caret: number } {
  const stripZeroX = opts.stripZeroX ?? true
  // 光标前的有效 hex 字符个数（"0x" 标记与空格/逗号等分隔符不计数）
  let k = 0
  for (let i = 0; i < caret && i < input.length; ) {
    if (
      stripZeroX &&
      input[i] === '0' &&
      (input[i + 1] === 'x' || input[i + 1] === 'X')
    ) {
      i += 2
      continue
    }
    if (/[0-9a-fA-F]/.test(input[i])) k++
    i++
  }

  // 顺序与 parseHexInput 一致：先剔除 "0x" 标记，再移除其余非 hex 字符
  let digits = stripZeroX ? input.replace(/0[xX]/g, '') : input
  digits = digits.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const parts: string[] = []
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2))

  // 第 k 个字符之后的格式化位置：k 个 hex 字符 + 它们之间已有的空格数
  const formattedCaret = k > 0 ? k + Math.floor((k - 1) / 2) : 0
  return { value: parts.join(' '), caret: formattedCaret }
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
