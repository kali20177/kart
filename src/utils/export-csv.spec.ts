import { describe, it, expect } from 'vitest'
import { exportMessagesAsCsv } from '@/utils/export-csv'
import type { Message } from '@/types'

function msg(overrides: Partial<Message> & { id: number }): Message {
  return {
    direction: 'rx',
    bytes: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
    timestamp: 1700000000000 + overrides.id * 100,
    ...overrides
  }
}

describe('exportMessagesAsCsv', () => {
  it('emits BOM + header + one row per message', () => {
    const messages: Message[] = [msg({ id: 1 }), msg({ id: 2 })]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const lines = csv.split('\n')
    expect(lines[0].startsWith('﻿')).toBe(true) // BOM
    expect(lines[0]).toContain('id,timestamp_abs')
    expect(lines.length).toBe(4) // header + 2 rows + trailing empty
  })

  it('includes delta and elapsed columns', () => {
    const messages: Message[] = [
      msg({ id: 1, timestamp: 1000 }),
      msg({ id: 2, timestamp: 1050 })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const lines = csv.split('\n')
    // row 2 should have delta_ms=50, elapsed_ms=50
    expect(lines[2]).toContain(',50,50,')
  })

  it('escapes fields with commas and quotes', () => {
    const messages: Message[] = [
      msg({
        id: 1,
        bytes: new TextEncoder().encode('say "hello", world'),
        error: 'bad, "stuff"'
      })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    expect(csv).toContain('"say ""hello"", world"')
  })

  it('sanitizes newlines in ascii column', () => {
    const messages: Message[] = [
      msg({
        id: 1,
        bytes: new Uint8Array([0x41, 0x54, 0x0d, 0x0a, 0x4f, 0x4b])
      })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    // \r\n → literal backslash-r backslash-n
    expect(csv).toContain('AT\\r\\nOK')
  })

  it('sanitizes binary control chars', () => {
    const messages: Message[] = [
      msg({
        id: 1,
        bytes: new Uint8Array([0x00, 0x01, 0x1f, 0x7f, 0x41])
      })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    // all control chars become ·
    expect(csv).toContain('····A')
  })

  it('handles empty message list', () => {
    const csv = exportMessagesAsCsv([], { encoding: 'utf-8' })
    const lines = csv.split('\n')
    expect(lines[0].startsWith('﻿')).toBe(true)
    expect(lines.length).toBe(2) // header + trailing newline = 1 data row → 2 with \n split
  })

  it('includes error column', () => {
    const messages: Message[] = [
      msg({ id: 1, direction: 'tx', error: 'send failed' }),
      msg({ id: 2, direction: 'rx' })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    expect(csv).toContain('send failed')
    // second row should have empty error
    const lines = csv.split('\n')
    expect(lines[2].endsWith(',')).toBe(true) // empty last field
  })

  it('correctly marks direction RX/TX', () => {
    const messages: Message[] = [
      msg({ id: 1, direction: 'rx' }),
      msg({ id: 2, direction: 'tx' })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    expect(csv).toContain(',RX,')
    expect(csv).toContain(',TX,')
  })

  it('emits note column value when set', () => {
    const messages: Message[] = [msg({ id: 1, note: 'kickoff' })]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const line = csv.split('\n')[1]
    expect(line.endsWith(',kickoff')).toBe(true)
  })

  it('emits empty note column when not set', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const line = csv.split('\n')[1]
    expect(line.endsWith(',')).toBe(true)
  })

  it('renders divider as a placeholder row with 10 columns', () => {
    const messages: Message[] = [
      msg({ id: 1, direction: 'rx' }),
      { id: 2, direction: 'tx', bytes: new Uint8Array(0), timestamp: 1700000000050, kind: 'divider', note: 'mark' },
      msg({ id: 3, timestamp: 1700000000100 })
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const lines = csv.split('\n')
    expect(lines[2]).toBe('--,--,--,--,--,--,--,--,--,mark')
    // 列数与 header 一致（10 列）
    expect(lines[0].replace('﻿', '').split(',').length).toBe(10)
    expect(lines[2].split(',').length).toBe(10)
  })

  it('escapes divider label that contains commas/quotes', () => {
    const messages: Message[] = [
      { id: 1, direction: 'tx', bytes: new Uint8Array(0), timestamp: 1700000000000, kind: 'divider', note: 'a, "b"' }
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8' })
    const line = csv.split('\n')[1]
    expect(line.endsWith(',"a, ""b"""')).toBe(true)
  })

  it('respects dataMode=hex — only includes data_hex column', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8', dataMode: 'hex' })
    const header = csv.split('\n')[0].replace('﻿', '')
    expect(header).toBe('id,timestamp_abs,elapsed_ms,delta_ms,direction,byte_count,data_hex,error,note')
    // 9 columns total (no data_ascii)
    expect(header.split(',').length).toBe(9)
    // data_ascii should NOT appear
    expect(header).not.toContain('data_ascii')
    // hex data should be present in the data row
    const row = csv.split('\n')[1]
    expect(row).toContain('48 65 6C 6C 6F')
  })

  it('respects dataMode=ascii — only includes data_ascii column', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8', dataMode: 'ascii' })
    const header = csv.split('\n')[0].replace('﻿', '')
    expect(header).toBe('id,timestamp_abs,elapsed_ms,delta_ms,direction,byte_count,data_ascii,error,note')
    // 9 columns total (no data_hex)
    expect(header.split(',').length).toBe(9)
    // data_hex should NOT appear
    expect(header).not.toContain('data_hex')
    // ascii data should be present in the data row
    const row = csv.split('\n')[1]
    expect(row).toContain('Hello')
  })

  it('renders divider with correct column count in hex mode', () => {
    const messages: Message[] = [
      { id: 1, direction: 'tx', bytes: new Uint8Array(0), timestamp: 1700000000000, kind: 'divider', note: 'mark' }
    ]
    const csv = exportMessagesAsCsv(messages, { encoding: 'utf-8', dataMode: 'hex' })
    const lines = csv.split('\n')
    // 9 columns in hex mode: id,ts,elapsed,delta,dir,byte_count,data_hex,error,note
    expect(lines[0].replace('﻿', '').split(',').length).toBe(9)
    expect(lines[1].split(',').length).toBe(9)
  })
})
