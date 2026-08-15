import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'
import { useMessagesStore, createMessagesStore, type MessagesDeps } from './messages'
import { usePauseStore } from './pause'
import { storeToRefs } from 'pinia'
import { DEFAULT_DECODER_CONFIG } from '@/decoders'
import type { DecoderConfig } from '@/decoders/types'

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

describe('messages store · 帧时间戳', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function flush() {
    vi.advanceTimersByTime(16)
  }

  it('gap-timeout 帧时间戳用字节到达时间，而非 gap 触发时刻（与波形 X 对齐）', () => {
    // 默认策略 gap-timeout, gapMs=20
    const s = useMessagesStore()
    vi.setSystemTime(1000)
    s.ingestRx(new Uint8Array([0x41, 0x0a])) // 字节在 t=1000 到达
    // gap 定时器在 t=1020 才触发关闭帧
    vi.advanceTimersByTime(20)
    flush()
    expect(s.messages.length).toBe(1)
    // 时间戳应为到达时刻 1000，而非 gap 触发时刻 1020（否则与波形 X 差 ~20ms）
    expect(s.messages[0].timestamp).toBe(1000)
  })

  it('delimiter 帧立即切出，时间戳为到达时间', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const s = useMessagesStore()
    vi.setSystemTime(5000)
    s.ingestRx(new Uint8Array([0x41, 0x0a]))
    flush()
    expect(s.messages[0].timestamp).toBe(5000)
  })
})

describe('messages store · 缓冲裁剪 droppedFrames', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function flush() {
    vi.advanceTimersByTime(16)
  }

  it('超 bufferLimit 裁剪最旧帧并累计丢弃数', () => {
    const settings = useSettingsStore()
    settings.settings.bufferLimit = 10
    const s = useMessagesStore()
    for (let i = 1; i <= 15; i++) s.addTx(new Uint8Array([i]))
    flush()
    expect(s.messages.length).toBe(10)
    expect(s.droppedFrames).toBe(5)
    // 保留的是最新 10 条（id 6..15），最旧 5 条被丢
    expect(s.messages.map((m) => m.id)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })

  it('多次刷入持续累计丢弃数', () => {
    const settings = useSettingsStore()
    settings.settings.bufferLimit = 5
    const s = useMessagesStore()
    for (let i = 1; i <= 6; i++) s.addTx(new Uint8Array([i]))
    flush()
    expect(s.droppedFrames).toBe(1) // 6 > 5 → 丢 1
    expect(s.messages.map((m) => m.id)).toEqual([2, 3, 4, 5, 6])
    for (let i = 7; i <= 10; i++) s.addTx(new Uint8Array([i]))
    flush()
    expect(s.droppedFrames).toBe(5) // 再丢 4，累计 5
    expect(s.messages.map((m) => m.id)).toEqual([6, 7, 8, 9, 10])
  })

  it('clear 重置丢弃计数', () => {
    const settings = useSettingsStore()
    settings.settings.bufferLimit = 5
    const s = useMessagesStore()
    for (let i = 1; i <= 8; i++) s.addTx(new Uint8Array([i]))
    flush()
    expect(s.droppedFrames).toBe(3)
    s.clear()
    expect(s.droppedFrames).toBe(0)
  })
})

describe('messages store · 帧解码', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function flush() {
    vi.advanceTimersByTime(16)
  }

  /** 用可注入的 decoder 配置直接构造 messages store（会话级解码配置经 deps 注入） */
  function makeStore(decoder: DecoderConfig) {
    const settings = useSettingsStore()
    const pause = usePauseStore()
    const { paused, pauseStartTime } = storeToRefs(pause)
    const scope = effectScope(true)
    const store = scope.run(() =>
      createMessagesStore({
        settings: settings.settings,
        decoder,
        paused,
        pauseStartTime,
        togglePause: () => pause.toggle()
      } satisfies MessagesDeps)
    )!
    return { store, scope }
  }

  it('选字段解码器且帧匹配 → 消息带 decoded 字段视图', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const decoder: DecoderConfig = {
      id: 'field',
      options: {
        header: 'AA55',
        fields: [
          { name: 'hdr', length: 2, format: 'hex' },
          { name: 'val', length: 2, format: 'u16be' }
        ]
      }
    }
    const { store, scope } = makeStore(decoder)
    try {
      // AA 55 12 34 \n → 匹配（header AA55），val=0x1234=4660
      store.ingestRx(new Uint8Array([0xaa, 0x55, 0x12, 0x34, 0x0a]))
      flush()
      expect(store.messages.value.length).toBe(1)
      const m = store.messages.value[0]
      expect(m.decoded).toBeDefined()
      expect(m.decoded?.decoderId).toBe('field')
      expect(m.decoded?.fields.map((f) => [f.name, f.value])).toEqual([
        ['hdr', 'AA 55'],
        ['val', '4660']
      ])
      // 原始字节始终保留
      expect(Array.from(m.bytes)).toEqual([0xaa, 0x55, 0x12, 0x34, 0x0a])
    } finally {
      scope.stop()
    }
  })

  it('header 不匹配的帧 → 无 decoded（保持原始帧）', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const decoder: DecoderConfig = {
      id: 'field',
      options: {
        header: 'AA55',
        fields: [{ name: 'val', length: 2, format: 'u16be' }]
      }
    }
    const { store, scope } = makeStore(decoder)
    try {
      store.ingestRx(new Uint8Array([0xbb, 0x55, 0x12, 0x34, 0x0a])) // 帧头不是 AA55
      flush()
      expect(store.messages.value.length).toBe(1)
      expect(store.messages.value[0].decoded).toBeUndefined()
    } finally {
      scope.stop()
    }
  })

  it('未选解码器（id 为空）→ 所有帧无 decoded', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const decoder = structuredClone(DEFAULT_DECODER_CONFIG) // id=''（下拉「无」）
    const { store, scope } = makeStore(decoder)
    try {
      store.ingestRx(new Uint8Array([0xaa, 0x55, 0x12, 0x34, 0x0a]))
      flush()
      expect(store.messages.value.length).toBe(1)
      expect(store.messages.value[0].decoded).toBeUndefined()
    } finally {
      scope.stop()
    }
  })

  it('运行时切换配置立即生效（配置为同一对象，逐帧读取）', () => {
    const settings = useSettingsStore()
    settings.settings.frame.strategy = 'delimiter'
    settings.settings.frame.delimiterHex = '0A'
    const decoder: DecoderConfig = {
      id: 'field',
      options: {
        header: 'BB55',
        fields: [{ name: 'val', length: 2, format: 'u16be' }]
      }
    }
    const { store, scope } = makeStore(decoder)
    try {
      store.ingestRx(new Uint8Array([0xbb, 0x55, 0x12, 0x34, 0x0a]))
      flush()
      expect(store.messages.value[0].decoded).toBeDefined()

      // 切 header 后，同帧不再匹配
      decoder.options.header = 'AA55'
      store.ingestRx(new Uint8Array([0xbb, 0x55, 0x12, 0x34, 0x0a]))
      flush()
      expect(store.messages.value[1].decoded).toBeUndefined()
    } finally {
      scope.stop()
    }
  })
})
