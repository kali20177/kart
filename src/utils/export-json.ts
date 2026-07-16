import type { Message, Encoding } from '@/types'
import { computeDeltas, formatTimestampISO } from './message-format'
import { decodeBytes, sanitizeForExport } from './encoding'
import { bytesToHex } from './hex'

export interface SessionMeta {
  port: string | null
  baudRate: number
  connectedAt: number | null
  encoding: Encoding
  dataMode?: 'ascii' | 'hex'
  totalRxBytes: number
  totalTxBytes: number
  totalRxFrames: number
  totalTxFrames: number
}

export interface JsonExportMessage {
  id: number
  timestamp: string
  timestampMs: number
  direction: string
  bytesHex?: string
  bytesBase64?: string
  bytesDecoded?: string
  byteCount: number
  elapsedMs: number
  deltaMs: number
  error: string | null
  kind: string
  transferId?: string
  note?: string
}

export interface JsonExportRoot {
  exportedAt: string
  session: {
    port: string | null
    baudRate: number
    connectedAt: string | null
    encoding: string
    totalRxBytes: number
    totalTxBytes: number
    totalRxFrames: number
    totalTxFrames: number
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
  const hexMode = meta.dataMode === 'hex'
  const asciiMode = meta.dataMode === 'ascii'

  const root: JsonExportRoot = {
    exportedAt,
    session: {
      port: meta.port,
      baudRate: meta.baudRate,
      connectedAt: meta.connectedAt != null ? formatTimestampISO(meta.connectedAt) : null,
      encoding: meta.encoding,
      totalRxBytes: meta.totalRxBytes,
      totalTxBytes: meta.totalTxBytes,
      totalRxFrames: meta.totalRxFrames,
      totalTxFrames: meta.totalTxFrames
    },
    messages: messages.map((m) => {
      if (m.kind === 'divider') {
        const msg: JsonExportMessage = {
          id: 0, timestamp: '--', timestampMs: 0,
          direction: '--', bytesHex: '--', bytesBase64: '--', bytesDecoded: '--',
          byteCount: 0, elapsedMs: 0, deltaMs: 0, error: null,
          kind: 'divider'
        }
        if (m.note) msg.note = m.note
        return msg
      }
      const d = deltas.get(m.id)
      const hexStr = bytesToHex(m.bytes)
      const decodedStr = sanitizeForExport(decodeBytes(m.bytes, meta.encoding))
      const msg: JsonExportMessage = {
        id: m.id,
        timestamp: formatTimestampISO(m.timestamp),
        timestampMs: m.timestamp,
        direction: m.direction,
        bytesHex: hexStr,
        bytesBase64: bytesToBase64(m.bytes),
        bytesDecoded: decodedStr,
        byteCount: m.bytes.length,
        elapsedMs: d?.elapsedMs ?? 0,
        deltaMs: d?.deltaMs ?? 0,
        error: m.error ?? null,
        kind: m.kind ?? 'frame'
      }
      if (hexMode) {
        delete msg.bytesDecoded
      }
      if (asciiMode) {
        delete msg.bytesHex
        delete msg.bytesBase64
      }
      if (m.transferId) msg.transferId = m.transferId
      if (m.note) msg.note = m.note
      return msg
    })
  }

  return JSON.stringify(root, null, 2)
}