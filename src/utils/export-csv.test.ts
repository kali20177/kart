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
})
