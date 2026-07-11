import type { Message } from '@/types'
import { computeDeltas, formatTimestampISO } from './message-format'
import { bytesToHex } from './hex'
import { sanitizeForExport } from './encoding'

export interface SessionMeta {
  port: string | null
  baudRate: number
  connectedAt: number | null
  totalRxBytes: number
  totalTxBytes: number
  totalRxFrames: number
}

export interface JsonExportMessage {
  id: number
  timestamp: string
  timestampMs: number
  direction: string
  bytesHex: string
  bytesBase64: string
  bytesDecoded: string
  byteCount: number
  elapsedMs: number
  deltaMs: number
  error: string | null
  kind: string
  transferId?: string
}

export interface JsonExportRoot {
  exportedAt: string
  session: {
    port: string | null
    baudRate: number
    connectedAt: string | null
    totalRxBytes: number
    totalTxBytes: number
    totalRxFrames: number
  }
  messages: JsonExportMessage[]
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * 将消息数组导出为 JSON 字符串（2 空格缩进）。
 */
export function exportMessagesAsJson(messages: Message[], meta: SessionMeta): string {
  const deltas = computeDeltas(messages)
  const exportedAt = formatTimestampISO(Date.now())

  const root: JsonExportRoot = {
    exportedAt,
    session: {
      port: meta.port,
      baudRate: meta.baudRate,
      connectedAt: meta.connectedAt ? formatTimestampISO(meta.connectedAt) : null,
      totalRxBytes: meta.totalRxBytes,
      totalTxBytes: meta.totalTxBytes,
      totalRxFrames: meta.totalRxFrames
    },
    messages: messages.map((m) => {
      const d = deltas.get(m.id)
      const msg: JsonExportMessage = {
        id: m.id,
        timestamp: formatTimestampISO(m.timestamp),
        timestampMs: m.timestamp,
        direction: m.direction,
        bytesHex: bytesToHex(m.bytes).replace(/ /g, ''),
        bytesBase64: bytesToBase64(m.bytes),
        bytesDecoded: sanitizeForExport(new TextDecoder().decode(m.bytes)),
        byteCount: m.bytes.length,
        elapsedMs: d?.elapsedMs ?? 0,
        deltaMs: d?.deltaMs ?? 0,
        error: m.error ?? null,
        kind: m.kind ?? 'frame'
      }
      if (m.transferId) msg.transferId = m.transferId
      return msg
    })
  }

  return JSON.stringify(root, null, 2)
}