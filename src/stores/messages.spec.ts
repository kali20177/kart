import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'
import { useMessagesStore } from './messages'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 触发 rAF 批处理 flush（messages store 用 rAF 合并刷入 pending） */
function flush() {
  vi.advanceTimersByTime(16)
}

describe('messages store · removeByIds', () => {
  it('删除指定 id，保留其余', () => {
    const s = useMessagesStore()
    s.addTx(new Uint8Array([0x01]))
    s.addTx(new Uint8Array([0x02]))
    s.addTx(new Uint8Array([0x03]))
    flush()
    expect(s.messages.map((m) => m.id)).toEqual([1, 2, 3])

    s.removeByIds([2])
    expect(s.messages.map((m) => m.id)).toEqual([1, 3])
  })

  it('批量删除多个 id', () => {
    const s = useMessagesStore()
    s.addTx(new Uint8Array([0x01]))
    s.addTx(new Uint8Array([0x02]))
    s.addTx(new Uint8Array([0x03]))
    s.addTx(new Uint8Array([0x04]))
    flush()
    s.removeByIds([1, 3])
    expect(s.messages.map((m) => m.id)).toEqual([2, 4])
  })

  it('空数组 noop', () => {
    const s = useMessagesStore()
    s.addTx(new Uint8Array([0x01]))
    flush()
    s.removeByIds([])
    expect(s.messages.length).toBe(1)
  })

  it('删除后 nextId 继续递增，新帧 id 不冲突', () => {
    const s = useMessagesStore()
    s.addTx(new Uint8Array([0x01])) // id 1
    flush()
    s.removeByIds([1])
    s.addTx(new Uint8Array([0x02])) // id 2
    flush()
    expect(s.messages.map((m) => m.id)).toEqual([2])
  })

  it('rxFrames 历史统计不减（delimiter 策略立即切帧）', () => {
    // 先于 messages store 构造前设定策略，splitter 初始即用 delimiter（不依赖 watch）
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const s = useMessagesStore()
    s.ingestRx(new Uint8Array([0x41, 0x0a])) // "A\n" → 切出一帧
    flush()
    expect(s.rxFrames).toBe(1)
    const id = s.messages[0].id
    s.removeByIds([id])
    expect(s.rxFrames).toBe(1) // 删除已显示帧不影响接收统计
    expect(s.messages.length).toBe(0)
  })
})
