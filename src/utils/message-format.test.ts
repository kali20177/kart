import { describe, it, expect } from 'vitest'
import { formatTimestamp, formatMessageLine } from '@/utils/message-format'
import type { Message } from '@/types'

// 固定本地时间：2026-07-03 14:23:05.128
const ts = new Date(2026, 6, 3, 14, 23, 5, 128).getTime()

function mk(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    direction: 'rx',
    bytes: new Uint8Array([0x4f, 0x4b]), // "OK"
    timestamp: ts,
    ...over
  }
}

describe('formatTimestamp', () => {
  it('short: HH:MM:SS.mmm', () => {
    expect(formatTimestamp(ts, 'short')).toBe('14:23:05.128')
  })

  it('full: YYYY-MM-DD HH:MM:SS.mmm', () => {
    expect(formatTimestamp(ts, 'full')).toBe('2026-07-03 14:23:05.128')
  })

  it('none: 空串', () => {
    expect(formatTimestamp(ts, 'none')).toBe('')
  })

  it('毫秒补零', () => {
    const t = new Date(2026, 0, 1, 0, 0, 0, 5).getTime()
    expect(formatTimestamp(t, 'short')).toBe('00:00:00.005')
  })
})

describe('formatMessageLine', () => {
  it('ASCII short: [时间] RX: 文本', () => {
    expect(formatMessageLine(mk(), { viewMode: 'ascii', encoding: 'utf-8' })).toBe(
      '[14:23:05.128] RX: OK'
    )
  })

  it('HEX short: [时间] RX: hex 串', () => {
    expect(formatMessageLine(mk(), { viewMode: 'hex', encoding: 'utf-8' })).toBe(
      '[14:23:05.128] RX: 4F 4B'
    )
  })

  it('full 时间戳', () => {
    expect(
      formatMessageLine(mk(), { viewMode: 'ascii', encoding: 'utf-8', timeStyle: 'full' })
    ).toBe('[2026-07-03 14:23:05.128] RX: OK')
  })

  it('none + withDirection=false: 仅内容（纯内容出口）', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        timeStyle: 'none',
        withDirection: false
      })
    ).toBe('OK')
  })

  it('none + withDirection: 方向 + 内容', () => {
    expect(
      formatMessageLine(mk(), { viewMode: 'hex', encoding: 'utf-8', timeStyle: 'none' })
    ).toBe('RX: 4F 4B')
  })

  it('TX 方向', () => {
    expect(
      formatMessageLine(mk({ direction: 'tx' }), { viewMode: 'ascii', encoding: 'utf-8' })
    ).toBe('[14:23:05.128] TX: OK')
  })

  it('withDirection=false + short: [时间]: 内容', () => {
    expect(
      formatMessageLine(mk(), { viewMode: 'ascii', encoding: 'utf-8', withDirection: false })
    ).toBe('[14:23:05.128]: OK')
  })

  it('空字节', () => {
    expect(
      formatMessageLine(mk({ bytes: new Uint8Array([]) }), {
        viewMode: 'ascii',
        encoding: 'utf-8'
      })
    ).toBe('[14:23:05.128] RX: ')
  })

  it('不可打印字节 ASCII 视图用 · 占位', () => {
    expect(
      formatMessageLine(mk({ bytes: new Uint8Array([0x00, 0x01]) }), {
        viewMode: 'ascii',
        encoding: 'ascii'
      })
    ).toBe('[14:23:05.128] RX: ··')
  })
})
