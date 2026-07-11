import type { Message } from '@/types'
import type { Encoding } from '@/types'
import { bytesToHex } from './hex'
import { decodeBytes, sanitizeForExport } from './encoding'
import { computeDeltas, formatTimestampISO } from './message-format'

export interface CsvExportOptions {
  encoding: Encoding
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * 将消息数组导出为 CSV 字符串。
 * 固定列：id, timestamp_abs, elapsed_ms, delta_ms, direction, byte_count, data_hex, data_ascii, error
 * 包含 UTF-8 BOM，Excel 可直接打开。
 */
export function exportMessagesAsCsv(messages: Message[], opts: CsvExportOptions): string {
  const deltas = computeDeltas(messages)
  const header = 'id,timestamp_abs,elapsed_ms,delta_ms,direction,byte_count,data_hex,data_ascii,error'
  const rows = [header]

  for (const m of messages) {
    const d = deltas.get(m.id)
    const hex = csvEscape(bytesToHex(m.bytes))
    const ascii = csvEscape(sanitizeForExport(decodeBytes(m.bytes, opts.encoding)))
    const error = csvEscape(m.error ?? '')
    const dir = m.direction === 'tx' ? 'TX' : 'RX'
    const tsAbs = csvEscape(formatTimestampISO(m.timestamp))

    rows.push(
      `${m.id},${tsAbs},${d?.elapsedMs ?? 0},${d?.deltaMs ?? 0},${dir},${m.bytes.length},${hex},${ascii},${error}`
    )
  }

  return '﻿' + rows.join('\n') + '\n'
}