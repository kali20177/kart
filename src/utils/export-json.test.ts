import { describe, it, expect } from 'vitest'
import { exportMessagesAsJson, type SessionMeta } from '@/utils/export-json'
import type { Message } from '@/types'

function msg(overrides: Partial<Message> & { id: number }): Message {
  return {
    direction: 'rx',
    bytes: new Uint8Array([0x41, 0x42, 0x43]),
    timestamp: 1700000000000 + overrides.id * 100,
    ...overrides
  }
}

const sessionMeta: SessionMeta = {
  port: 'COM3',
  baudRate: 115200,
  connectedAt: 1700000000000,
  encoding: 'utf-8',
  totalRxBytes: 12345,
  totalTxBytes: 678,
  totalRxFrames: 150,
  totalTxFrames: 12
}

describe('exportMessagesAsJson', () => {
  it('produces valid JSON with session metadata', () => {
    const messages: Message[] = [msg({ id: 1 }), msg({ id: 2 })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.exportedAt).toBeDefined()
    expect(parsed.session.port).toBe('COM3')
    expect(parsed.session.baudRate).toBe(115200)
    expect(parsed.session.totalRxBytes).toBe(12345)
    expect(parsed.messages.length).toBe(2)
  })

  it('includes bytesHex and bytesBase64', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].bytesHex).toBe('414243')
    expect(parsed.messages[0].bytesBase64).toBe('QUJD')
    expect(parsed.messages[0].byteCount).toBe(3)
    expect(parsed.messages[0].bytesDecoded).toBe('ABC')
  })

  it('sanitizes newlines in bytesDecoded', () => {
    const messages: Message[] = [
      msg({ id: 1, bytes: new Uint8Array([0x41, 0x54, 0x0d, 0x0a, 0x4f, 0x4b]) })
    ]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].bytesDecoded).toBe('AT\\r\\nOK')
  })

  it('computes delta and elapsed', () => {
    const messages: Message[] = [
      msg({ id: 1, timestamp: 1000 }),
      msg({ id: 2, timestamp: 1050 })
    ]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].deltaMs).toBe(0)
    expect(parsed.messages[0].elapsedMs).toBe(0)
    expect(parsed.messages[1].deltaMs).toBe(50)
    expect(parsed.messages[1].elapsedMs).toBe(50)
  })

  it('omits transferId when not present', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].transferId).toBeUndefined()
  })

  it('includes transferId for file messages', () => {
    const messages: Message[] = [
      msg({ id: 1, kind: 'file', transferId: 'tf-123', bytes: new Uint8Array(0) })
    ]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].transferId).toBe('tf-123')
    expect(parsed.messages[0].kind).toBe('file')
    expect(parsed.messages[0].bytesBase64).toBe('')
  })

  it('null error when not set', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].error).toBeNull()
  })

  it('includes error string when set', () => {
    const messages: Message[] = [msg({ id: 1, direction: 'tx', error: 'timeout' })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].error).toBe('timeout')
  })

  it('handles empty message list', () => {
    const json = exportMessagesAsJson([], sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages).toEqual([])
    expect(parsed.session).toBeDefined()
  })

  it('handles null port and connectedAt', () => {
    const meta: SessionMeta = { ...sessionMeta, port: null, connectedAt: null }
    const json = exportMessagesAsJson([msg({ id: 1 })], meta)
    const parsed = JSON.parse(json)
    expect(parsed.session.port).toBeNull()
    expect(parsed.session.connectedAt).toBeNull()
  })

  it('handles connectedAt 0 correctly (not falsy)', () => {
    const meta: SessionMeta = { ...sessionMeta, connectedAt: 0 }
    const json = exportMessagesAsJson([msg({ id: 1 })], meta)
    const parsed = JSON.parse(json)
    expect(parsed.session.connectedAt).not.toBeNull()
    expect(parsed.session.connectedAt).toContain('1970-01-01')
  })

  it('includes encoding and txFrames in session', () => {
    const json = exportMessagesAsJson([msg({ id: 1 })], sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.session.encoding).toBe('utf-8')
    expect(parsed.session.totalTxFrames).toBe(12)
  })

  it('uses meta.encoding for bytesDecoded', () => {
    // GBK encoding: 0xBA 0xBA = "汉"
    const meta: SessionMeta = { ...sessionMeta, encoding: 'gbk' }
    const messages: Message[] = [msg({ id: 1, bytes: new Uint8Array([0xBA, 0xBA]) })]
    const json = exportMessagesAsJson(messages, meta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].bytesDecoded).toBe('汉')
  })

  it('includes note when set on a frame', () => {
    const messages: Message[] = [msg({ id: 1, note: 'kickoff' })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].note).toBe('kickoff')
  })

  it('omits note when not set', () => {
    const messages: Message[] = [msg({ id: 1 })]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].note).toBeUndefined()
  })

  it('renders divider as a placeholder message', () => {
    const messages: Message[] = [
      msg({ id: 1 }),
      { id: 2, direction: 'tx', bytes: new Uint8Array(0), timestamp: 1700000000050, kind: 'divider', note: 'mark' }
    ]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    const d = parsed.messages[1]
    expect(d.kind).toBe('divider')
    expect(d.id).toBe(0)
    expect(d.direction).toBe('--')
    expect(d.bytesHex).toBe('--')
    expect(d.byteCount).toBe(0)
    expect(d.note).toBe('mark')
  })

  it('divider placeholder omits note when no label', () => {
    const messages: Message[] = [
      { id: 1, direction: 'tx', bytes: new Uint8Array(0), timestamp: 1700000000000, kind: 'divider' }
    ]
    const json = exportMessagesAsJson(messages, sessionMeta)
    const parsed = JSON.parse(json)
    expect(parsed.messages[0].note).toBeUndefined()
    expect(parsed.messages[0].kind).toBe('divider')
  })
})
