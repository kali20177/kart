import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessagesStore } from './messages'
import { useWaveformStore } from './waveform'
import { usePauseStore } from './pause'
import { useSettingsStore } from './settings'

const enc = (s: string) => new TextEncoder().encode(s)

// 验证暂停是应用级单一真相源：消息视图与波形视图共享同一个 paused，
// 一处暂停 → 两处 ingest 同步丢弃同一批字节 → 采样集合对齐（不存在「这边有那边没有」）。
beforeEach(() => {
  setActivePinia(createPinia())
})

function flush() {
  vi.advanceTimersByTime(16)
}

describe('全局暂停：消息与波形共享同一状态', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('在波形视图暂停 → 消息视图 ingestRx 也丢弃', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const msgs = useMessagesStore()
    const wf = useWaveformStore()
    const pause = usePauseStore()

    wf.togglePause() // 从波形侧暂停
    expect(pause.paused).toBe(true)
    expect(msgs.paused).toBe(true) // 消息侧同步为已暂停
    expect(wf.paused).toBe(true)

    msgs.ingestRx(new Uint8Array([0x41, 0x0a])) // 暂停期：消息 ingest 应丢弃
    flush()
    expect(msgs.messages.length).toBe(0)
    wf.ingest(enc('1,2\n')) // 暂停期：波形 ingest 应丢弃
    expect(wf.data[0].length).toBe(0)
  })

  it('在消息视图暂停 → 波形视图 ingest 也丢弃', () => {
    const msgs = useMessagesStore()
    const wf = useWaveformStore()
    const pause = usePauseStore()

    msgs.togglePause() // 从消息侧暂停
    expect(pause.paused).toBe(true)
    expect(wf.paused).toBe(true)

    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(0)
    // 恢复后波形正常摄入
    msgs.togglePause()
    expect(wf.paused).toBe(false)
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(1)
  })

  it('从一侧恢复 → 另一侧也同步恢复', () => {
    const msgs = useMessagesStore()
    const wf = useWaveformStore()
    wf.togglePause()
    expect(wf.paused).toBe(true)
    msgs.togglePause() // 从消息侧恢复
    expect(wf.paused).toBe(false)
    expect(msgs.paused).toBe(false)
  })
})
