import type { DataMode, Encoding, Message } from '@/types'
import { bytesToHex } from './hex'
import { decodeBytes } from './encoding'

/** 时间戳格式 */
export type TimeStyle = 'short' | 'full' | 'none'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/**
 * 格式化毫秒时间戳。
 * - short：HH:MM:SS.mmm（对齐气泡显示）
 * - full ：YYYY-MM-DD HH:MM:SS.mmm（对齐导出归档）
 * - none ：空串
 */
export function formatTimestamp(ts: number, style: TimeStyle): string {
  if (style === 'none') return ''
  const d = new Date(ts)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`
  if (style === 'short') return time
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

export interface FormatLineOptions {
  viewMode: DataMode
  encoding: Encoding
  /** 默认 'short' */
  timeStyle?: TimeStyle
  /** 默认 true */
  withDirection?: boolean
}

/**
 * 把一条消息格式化为一行：`[时间] DIR: 内容`。
 * 内容随 viewMode：ASCII 取解码文本，HEX 取空格分隔的单行 hex 串。
 * timeStyle='none' 且 withDirection=false 时仅返回内容（纯内容出口）。
 */
export function formatMessageLine(m: Message, opts: FormatLineOptions): string {
  const { viewMode, encoding } = opts
  const timeStyle = opts.timeStyle ?? 'short'
  const withDirection = opts.withDirection ?? true

  const content = viewMode === 'hex' ? bytesToHex(m.bytes) : decodeBytes(m.bytes, encoding)

  const prefixParts: string[] = []
  if (timeStyle !== 'none') prefixParts.push(`[${formatTimestamp(m.timestamp, timeStyle)}]`)
  if (withDirection) prefixParts.push(m.direction === 'tx' ? 'TX' : 'RX')
  const prefix = prefixParts.join(' ')

  return prefix ? `${prefix}: ${content}` : content
}
