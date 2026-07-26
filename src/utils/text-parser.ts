import type { WaveformParseConfig } from '@/types'

/**
 * 文本行解析器（Arduino Serial.println 风格）。
 *
 * 把字节流解码为文本，按换行切行，每行解析为若干十进制数字 -> 多通道采样。
 * 返回 { perChannel, remainder } 格式，waveform store 下游 ingest / history / view / chart 无需改动。
 *
 * 设计要点：
 *  - **一行 = 一个采样点**。
 *  - 数字按 `[,\s;]+` 分割（逗号 / 空白 / 分号均可），覆盖 Arduino 常见写法：
 *      Serial.println(analogRead(A0))            -> 单值/行 -> 1 通道
 *      Serial.print(a); Serial.print(','); ...   -> a,b/行  -> 2 通道
 *  - 支持 label:value 格式，按标签名匹配通道：
 *      Serial.print("Sin:"); Serial.print(x); Serial.print(",Cos:"); Serial.println(y);
 *      -> "Sin:0.5,Cos:0.86" -> 标签 "Sin"→通道0、"Cos"→通道1
 *  - 通道数由数据内容自动检测——无标签 token 按递增位置、有标签 token 按 labelIndex 分配；
 *    不依赖外部配置。
 *  - 数值不足的通道补 NaN（uPlot spanGaps 跨连，渲染为缺口）；
 *    整行无有效数值则跳过（不产生采样点）。
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

/** 单个 token 的解析结果 */
interface TokenValue {
  /** 标签名（仅 label:value 格式时有值）；无标签 token 为 undefined */
  label?: string
  /** 解析出的数值；null 表示无效 */
  value: number | null
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
 * 解析单个 token：检测 label:value 格式，提取标签名与数值。
 * - 匹配 `Label:value` → { label: "Label", value: parseFiniteNumber(value) }
 * - 不匹配 → { value: parseFiniteNumber(token) }
 * 标签名规则：字母或下划线开头，后可接字母/数字/下划线（符合 C/Arduino 变量名习惯）。
 */
function parseToken(token: string): TokenValue {
  const trimmed = token.trim()
  const labelMatch = trimmed.match(/^([a-zA-Z_]\w*)\s*:\s*(\S.*)$/)
  if (labelMatch) {
    const v = parseFiniteNumber(labelMatch[2])
    if (v !== null) return { label: labelMatch[1], value: v }
    // 标签有效但数值无效 → 整 token 无效
    return { value: null }
  }
  return { value: parseFiniteNumber(token) }
}

/**
 * 把字节流按行切，读出每通道数值。
 *
 * @param bytes      本批到达的字节
 * @param cfg        解析配置（当前为空占位，未来协议在此扩展）
 * @param carryover  上批遗留的半截行字符串（拼到本批文本前）
 * @param labelIndex 标签→通道索引映射（由 waveform store 持有，非响应式）。
 *                   首次传 undefined 或不传 → 按位置匹配（兼容无标签数据）。
 *                   有值则该 Map 会原地更新（新标签分配新索引），调用方可通过
 *                   .size 感知新增通道数。
 */
export function parseTextSamples(
  bytes: Uint8Array,
  _cfg: WaveformParseConfig,
  carryover: string = '',
  labelIndex?: Map<string, number>
): ParseResult {
  const minChannels = 1
  const decoded = carryover + new TextDecoder().decode(bytes)

  // 按 \r\n / \n / \r 切行；末尾未结束的半截行作为 remainder 留给下批
  const parts = decoded.split(/\r\n|\n|\r/)
  const remainder = parts.pop() ?? ''

  // 初始通道数 = 1；解析过程中按 token 位置 / 标签自动扩容
  const perChannel: number[][] = [[]]

  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const tokens = trimmed.split(/[,\s;]+/).filter(Boolean)
    const values = new Map<number, number>()
    let posCounter = 0 // 无标签 token 的递增位置计数器

    for (const token of tokens) {
      const tv = parseToken(token)
      if (tv.value === null) continue

      let ch: number
      if (tv.label && labelIndex) {
        // 标签化 token → 按标签名匹配 / 分配索引
        const existing = labelIndex.get(tv.label)
        if (existing != null) {
          ch = existing
        } else {
          ch = labelIndex.size
          labelIndex.set(tv.label, ch)
        }
      } else {
        // 无标签 token → 按递增位置
        ch = posCounter
        posCounter++
      }

      // 动态扩容 perChannel（标签模式或 pos 增长均可触发）
      while (perChannel.length <= ch) {
        perChannel.push([])
      }
      values.set(ch, tv.value)
    }

    if (values.size === 0) continue // 整行无有效数值 → 跳过，不产生采样点

    // 有效通道数 ≥ minChannels；不足补 NaN
    const chCount = Math.max(minChannels, perChannel.length)
    for (let c = 0; c < chCount; c++) {
      perChannel[c].push(values.has(c) ? values.get(c)! : NaN)
    }
  }

  return { perChannel, remainder }
}
