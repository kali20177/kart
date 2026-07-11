import { describe, it, expect } from 'vitest'
import {
  formatTimestamp,
  formatTimestampISO,
  formatMessageLine,
  computeDeltas,
  formatDelta,
  formatElapsed
} from '@/utils/message-format'
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

  // 新增字段测试
  it('withFrameNumber', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withFrameNumber: true,
        frameNumber: 42
      })
    ).toBe('[#00042] [14:23:05.128] RX: OK')
  })

  it('withByteCount', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withByteCount: true
      })
    ).toBe('[14:23:05.128] RX (2B): OK')
  })

  it('withDeltaMs', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withDeltaMs: true,
        deltaMs: 45
      })
    ).toBe('[14:23:05.128] Δ45ms RX: OK')
  })

  it('withElapsed', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withElapsed: true,
        elapsedMs: 1230
      })
    ).toBe('[14:23:05.128] +1.23s RX: OK')
  })

  it('withError', () => {
    expect(
      formatMessageLine(mk({ error: 'timeout' }), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withError: true
      })
    ).toBe('[14:23:05.128] RX: OK [ERR: timeout]')
  })

  it('withError skips when no error', () => {
    expect(
      formatMessageLine(mk(), {
        viewMode: 'ascii',
        encoding: 'utf-8',
        withError: true
      })
    ).toBe('[14:23:05.128] RX: OK')
  })

  it('all fields combined', () => {
    expect(
      formatMessageLine(mk({ error: 'fail' }), {
        viewMode: 'hex',
        encoding: 'utf-8',
        timeStyle: 'full',
        withFrameNumber: true,
        frameNumber: 1,
        withByteCount: true,
        withDeltaMs: true,
        deltaMs: 100,
        withElapsed: true,
        elapsedMs: 500,
        withError: true
      })
    ).toBe('[#00001] [2026-07-03 14:23:05.128] +0.500s Δ100ms RX (2B): 4F 4B [ERR: fail]')
  })
})

describe('formatTimestampISO', () => {
  it('ISO 8601 format', () => {
    expect(formatTimestampISO(ts)).toBe('2026-07-03T14:23:05.128')
  })
})

describe('computeDeltas', () => {
  it('empty list returns empty map', () => {
    expect(computeDeltas([]).size).toBe(0)
  })

  it('single message has zero delta/elapsed', () => {
    const map = computeDeltas([mk()])
    expect(map.get(mk().id)).toEqual({ deltaMs: 0, elapsedMs: 0 })
  })

  it('two messages compute correct deltas', () => {
    const m1: Message = { id: 1, direction: 'rx', bytes: new Uint8Array(), timestamp: 1000 }
    const m2: Message = { id: 2, direction: 'rx', bytes: new Uint8Array(), timestamp: 1050 }
    const map = computeDeltas([m1, m2])
    expect(map.get(1)).toEqual({ deltaMs: 0, elapsedMs: 0 })
    expect(map.get(2)).toEqual({ deltaMs: 50, elapsedMs: 50 })
  })

  it('three messages with gaps', () => {
    const m1: Message = { id: 1, direction: 'rx', bytes: new Uint8Array(), timestamp: 0 }
    const m2: Message = { id: 2, direction: 'rx', bytes: new Uint8Array(), timestamp: 100 }
    const m3: Message = { id: 3, direction: 'rx', bytes: new Uint8Array(), timestamp: 250 }
    const map = computeDeltas([m1, m2, m3])
    expect(map.get(3)).toEqual({ deltaMs: 150, elapsedMs: 250 })
  })

  it('negative timestamps clamp to zero', () => {
    const m1: Message = { id: 1, direction: 'rx', bytes: new Uint8Array(), timestamp: 2000 }
    const m2: Message = { id: 2, direction: 'rx', bytes: new Uint8Array(), timestamp: 1000 }
    const map = computeDeltas([m1, m2])
    expect(map.get(2)).toEqual({ deltaMs: 0, elapsedMs: 0 })
  })
})

describe('formatDelta', () => {
  it('ms < 1000', () => expect(formatDelta(45)).toBe('Δ45ms'))
  it('ms < 10000', () => expect(formatDelta(1500)).toBe('Δ1.50s'))
  it('ms >= 10000', () => expect(formatDelta(12500)).toBe('Δ12.5s'))
})

describe('formatElapsed', () => {
  it('ms < 1000', () => expect(formatElapsed(500)).toBe('+0.500s'))
  it('ms < 10000', () => expect(formatElapsed(2500)).toBe('+2.50s'))
  it('ms < 60000', () => expect(formatElapsed(30000)).toBe('+30.0s'))
  it('ms >= 60000', () => expect(formatElapsed(125000)).toBe('+2m5.0s'))
  it('浮点数安全截断', () => expect(formatElapsed(500.9)).toBe('+0.500s'))
})
