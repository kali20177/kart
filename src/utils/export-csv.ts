import type { Message } from '@/types'
import type { Encoding } from '@/types'
import { bytesToHex } from './hex'
import { decodeBytes, sanitizeForExport } from './encoding'
import { computeDeltas, formatTimestampISO } from './message-format'

export interface CsvExportOptions {
  encoding: Encoding
  dataMode?: 'ascii' | 'hex'
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * 将消息数组导出为 CSV 字符串。
 * 固定列前 6 个：id, timestamp_abs, elapsed_ms, delta_ms, direction, byte_count
 * data_hex / data_ascii 按 dataMode 选项决定包含哪些：
 *   - 'hex'   → 仅 data_hex
 *   - 'ascii' → 仅 data_ascii
 *   - 不指定  → 两者都包含（向后兼容）
 * 最后两列：error, note
 * 包含 UTF-8 BOM，Excel 可直接打开。
 */
export function exportMessagesAsCsv(messages: Message[], opts: CsvExportOptions): string {
  const deltas = computeDeltas(messages)
  const dataColumns = opts.dataMode === 'hex'
    ? ['data_hex']
    : opts.dataMode === 'ascii'
      ? ['data_ascii']
      : ['data_hex', 'data_ascii']
  const header = `id,timestamp_abs,elapsed_ms,delta_ms,direction,byte_count,${dataColumns.join(',')},error,note`
  const rows = [header]

  for (const m of messages) {
    const d = deltas.get(m.id)
    const error = csvEscape(m.error ?? '')
    const dir = m.direction === 'tx' ? 'TX' : 'RX'
    const tsAbs = csvEscape(formatTimestampISO(m.timestamp))
    const note = csvEscape(m.note ?? '')

    if (m.kind === 'divider') {
      const placeholder = ['--', '--', '--', '--', '--', '--', ...dataColumns.map(() => '--'), '--', note]
      rows.push(placeholder.join(','))
      continue
    }

    const hex = csvEscape(bytesToHex(m.bytes))
    const ascii = csvEscape(sanitizeForExport(decodeBytes(m.bytes, opts.encoding)))
    const dataValues = dataColumns.map((col) => col === 'data_hex' ? hex : ascii)

    rows.push(
      `${m.id},${tsAbs},${d?.elapsedMs ?? 0},${d?.deltaMs ?? 0},${dir},${m.bytes.length},${dataValues.join(',')},${error},${note}`
    )
  }

  return '﻿' + rows.join('\n') + '\n'
}