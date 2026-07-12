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

/** ISO 8601 完整时间戳（CSV/JSON 导出用） */
export function formatTimestampISO(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export interface FormatLineOptions {
  viewMode: DataMode
  encoding: Encoding
  /** 默认 'short' */
  timeStyle?: TimeStyle
  /** 默认 true */
  withDirection?: boolean
  /** 帧序号 */
  withFrameNumber?: boolean
  /** 字节数 */
  withByteCount?: boolean
  /** Δt（距上一帧 ms） */
  withDeltaMs?: boolean
  /** 累计时间（距首帧） */
  withElapsed?: boolean
  /** 错误标记 */
  withError?: boolean
  /** 帧序号（传入值） */
  frameNumber?: number
  /** Δt ms（传入值） */
  deltaMs?: number
  /** 累计 ms（传入值） */
  elapsedMs?: number
}

/** computeDeltas 返回的增量信息 */
export interface DeltaInfo {
  deltaMs: number
  elapsedMs: number
}

/** 为消息数组计算每帧的 Δt 和累计时间 */
export function computeDeltas(messages: Message[]): Map<number, DeltaInfo> {
  const map = new Map<number, DeltaInfo>()
  if (messages.length === 0) return map
  const base = messages[0].timestamp
  map.set(messages[0].id, { deltaMs: 0, elapsedMs: 0 })
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1].timestamp
    const cur = messages[i].timestamp
    map.set(messages[i].id, {
      deltaMs: Math.max(0, cur - prev),
      elapsedMs: Math.max(0, cur - base)
    })
  }
  return map
}

/** 格式化 Δt 为人类可读字符串 */
export function formatDelta(ms: number): string {
  if (ms < 1000) return `Δ${ms}ms`
  if (ms < 10000) return `Δ${(ms / 1000).toFixed(2)}s`
  return `Δ${(ms / 1000).toFixed(1)}s`
}

/** 格式化累计时间为人类可读字符串 */
export function formatElapsed(ms: number): string {
  ms = Math.floor(ms)
  if (ms < 1000) return `+0.${pad(ms, 3)}s`
  if (ms < 10000) return `+${(ms / 1000).toFixed(2)}s`
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = ((ms % 60000) / 1000).toFixed(1)
  return `+${mins}m${secs}s`
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

  // 分隔线特殊格式化（无字节数据，不参与常规帧格式化）
  if (m.kind === 'divider') {
    const prefix = timeStyle !== 'none' ? `[${formatTimestamp(m.timestamp, timeStyle)}]` : ''
    const label = m.note ? ` ${m.note} ` : ''
    const line = '─'.repeat(20)
    return prefix ? `${prefix} ${line}${label}${line}` : `${line}${label}${line}`
  }

  const content = viewMode === 'hex' ? bytesToHex(m.bytes) : decodeBytes(m.bytes, encoding)

  const prefixParts: string[] = []

  if (opts.withFrameNumber && opts.frameNumber != null) {
    prefixParts.push(`[#${String(opts.frameNumber).padStart(5, '0')}]`)
  }

  if (timeStyle !== 'none') prefixParts.push(`[${formatTimestamp(m.timestamp, timeStyle)}]`)

  if (opts.withElapsed && opts.elapsedMs != null) {
    prefixParts.push(formatElapsed(opts.elapsedMs))
  }

  if (opts.withDeltaMs && opts.deltaMs != null) {
    prefixParts.push(formatDelta(opts.deltaMs))
  }

  if (withDirection) {
    let dirStr = m.direction === 'tx' ? 'TX' : 'RX'
    if (opts.withByteCount) dirStr += ` (${m.bytes.length}B)`
    prefixParts.push(dirStr)
  } else if (opts.withByteCount) {
    prefixParts.push(`(${m.bytes.length}B)`)
  }

  const prefix = prefixParts.join(' ')

  let line = prefix ? `${prefix}: ${content}` : content

  if (opts.withError && m.error) {
    line += ` [ERR: ${m.error}]`
  }

  if (m.note) {
    line += ` [Note: ${m.note}]`
  }

  return line
}
