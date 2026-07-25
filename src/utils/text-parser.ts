import type { WaveformParseConfig } from '@/types'

/**
 * 文本行解析器（Arduino Serial.println 风格）。
 *
 * 把字节流解码为文本，按换行切行，每行解析为若干十进制数字 -> 多通道采样。
 * 与 byte-parser.parseSamples 返回形状一致（{ perChannel, remainder }），
 * 故 waveform store 下游 ingest / history / view / chart 无需改动。
 *
 * 设计要点：
 *  - **一行 = 一个采样点**（与二进制模式一个 record = 一个采样点对齐）。
 *  - 数字按 `[,\s;]+` 分割（逗号 / 空白 / 分号均可），覆盖 Arduino 常见写法：
 *      Serial.println(analogRead(A0))            -> 单值/行 -> 1 通道
 *      Serial.print(a); Serial.print(','); ...   -> a,b/行  -> 2 通道
 *  - 取每行前 `channels` 个有效数值；不足补 NaN（uPlot spanGaps 跨连，渲染为缺口）；
 *    多余忽略；整行无有效数值则跳过（不产生采样点）。
 *  - carryover 为上批未结束的半截行**字符串**，跨回调拼到下批开头（半截行不立即成点，
 *    等下批补全换行后再切，避免把 `12.` + `5` 误判成两个点）。
 *
 * 无状态纯函数，不依赖 Vue，可独立单测。
 */

interface ParseResult {
  /** perChannel[ch] = 本批新增的采样值数组（按行到达顺序；缺失值用 NaN 占位） */
  perChannel: number[][]
  /** 上批遗留的半截行字符串，原样传回给下次 parseTextSamples 的 carryover */
  remainder: string
}

/**
 * 手写有限数值校验：接受 +/-、小数、科学计数法，且**整串消耗完**才合法。
 * 比 Number()/parseFloat 严格 -- 正确拒绝 `12abc`、`1.2.3` 这类，避免误当成数值。
 * 空串、纯符号、指数无数字均返回 null。
 */
function parseFiniteNumber(token: string): number | null {
  const text = token.trim().toLowerCase()
  if (!text) return null

  let i = 0
  if (text[i] === '+' || text[i] === '-') i += 1

  let digits = 0
  while (text[i] >= '0' && text[i] <= '9') { digits += 1; i += 1 }
  if (text[i] === '.') {
    i += 1
    while (text[i] >= '0' && text[i] <= '9') { digits += 1; i += 1 }
  }
  if (digits === 0) return null

  if (text[i] === 'e') {
    i += 1
    if (text[i] === '+' || text[i] === '-') i += 1
    let expDigits = 0
    while (text[i] >= '0' && text[i] <= '9') { expDigits += 1; i += 1 }
    if (expDigits === 0) return null
  }

  if (i !== text.length) return null

  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * 把字节流按行切，读出每通道数值。
 *
 * @param bytes    本批到达的字节
 * @param cfg      解析配置（用 channels 决定每行取几个值）
 * @param carryover 上批遗留的半截行字符串（拼到本批文本前）
 */
export function parseTextSamples(
  bytes: Uint8Array,
  cfg: WaveformParseConfig,
  carryover: string = ''
): ParseResult {
  const channels = Math.max(1, cfg.channels)
  const decoded = carryover + new TextDecoder().decode(bytes)

  // 按 \r\n / \n / \r 切行；末尾未结束的半截行作为 remainder 留给下批
  const parts = decoded.split(/\r\n|\n|\r/)
  const remainder = parts.pop() ?? ''

  const perChannel: number[][] = Array.from({ length: channels }, () => [])

  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const tokens = trimmed.split(/[,\s;]+/).filter(Boolean)
    const values: number[] = []
    for (const token of tokens) {
      const v = parseFiniteNumber(token)
      if (v !== null) values.push(v)
      // 数值与 token 不一致顺序无关：仅收集有效数值，非数值 token 跳过
      if (values.length >= channels) break
    }

    if (values.length === 0) continue // 整行无有效数值 -> 跳过，不产生采样点

    for (let c = 0; c < channels; c++) {
      perChannel[c].push(values[c] ?? NaN)
    }
  }

  return { perChannel, remainder }
}
