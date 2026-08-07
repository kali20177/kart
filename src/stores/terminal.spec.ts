import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createTerminalStore, type TerminalDeps } from './terminal'
import { lineToText } from '@/terminal/screen-buffer'
import type { AppSettings } from '@/types'

const enc = new TextEncoder()

function makeSettings(partial?: Partial<AppSettings['terminal']>): AppSettings {
  return {
    encoding: 'utf-8',
    frame: { strategy: 'gap-timeout', gapMs: 20, delimiterHex: '0D0A', fixedLength: 8 },
    bufferLimit: 5000,
    defaultView: 'ascii',
    themeId: 'glass-industrial-dark',
    fontSize: 13,
    locale: 'zh-CN',
    waveform: { parse: {}, maxPoints: 5000, maxHistoryPoints: 200_000 },
    terminal: {
      cols: 0,
      rows: 0,
      fontScale: 1,
      transmitMode: 'char',
      echo: false,
      backspace: 'del',
      lineEnding: 'crlf',
      scrollbackLimit: 100,
      ...partial,
    },
    autoReconnect: false,
    showPauseNotification: true,
    recordFormat: 'text',
    sendChecksum: 'none',
    rxChecksumAlgorithm: 'none',
  }
}

/** 触发 rAF 批处理 flush（terminal store 用 rAF 合并刷入 lines） */
function flush() {
  vi.advanceTimersByTime(16)
}

function setup(settings?: AppSettings) {
  let cb: (bytes: Uint8Array) => void = () => {}
  const sent: Uint8Array[] = []
  const paused = ref(false)
  const pauseStartTime = ref(0)
  const store = createTerminalStore({
    onData: (fn) => {
      cb = fn
      return () => {}
    },
    sendRaw: async (b) => {
      sent.push(b)
      return { ok: true }
    },
    paused,
    pauseStartTime,
    settings: settings ?? makeSettings(),
  } as TerminalDeps)
  return { store, emit: (b: Uint8Array) => cb(b), sent, paused }
}

describe('terminal store · 摄入与渲染', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('原始字节 → ANSI 解析 → lines 渲染（含 SGR 颜色与 CR 重绘）', () => {
    const { store, emit } = setup()
    emit(enc.encode('\x1b[1;32mroot@kart:~# \x1b[0m\x1b[31mERR\x1b[0m\r\nok'))
    flush()
    expect(store.lines.value.length).toBe(2)
    expect(lineToText(store.lines.value[0])).toBe('root@kart:~# ERR')
    expect(lineToText(store.lines.value[1])).toBe('ok')
    expect(store.lines.value[0].cells[0]).toMatchObject({ ch: 'r', bold: true, fg: '#008000' })
    expect(store.lines.value[0].cells[13]).toMatchObject({ ch: 'E', bold: false, fg: '#800000' })
  })

  it('连续输入累计为单行，光标位置更新', () => {
    const { store, emit } = setup()
    emit(enc.encode('hel'))
    flush()
    expect(lineToText(store.lines.value[0])).toBe('hel')
    emit(enc.encode('lo'))
    flush()
    expect(lineToText(store.lines.value[0])).toBe('hello')
    expect(store.cursor.value.col).toBe(5)
  })

  it('滚动输出产生多行', () => {
    const { store, emit } = setup()
    emit(enc.encode('a\r\nb\r\nc'))
    flush()
    expect(store.lines.value.map((l) => lineToText(l))).toEqual(['a', 'b', 'c'])
  })

  it('clear 清空全部并重置光标', () => {
    const { store, emit } = setup()
    emit(enc.encode('hello'))
    flush()
    store.clear()
    expect(store.lines.value.length).toBe(1)
    expect(lineToText(store.lines.value[0])).toBe('')
    expect(store.cursor.value).toEqual({ line: 0, col: 0 })
  })

  it('暂停时丢弃摄入，恢复后继续', () => {
    const { store, emit, paused } = setup()
    paused.value = true
    emit(enc.encode('drop'))
    flush()
    expect(store.lines.value.length).toBe(0)
    paused.value = false
    emit(enc.encode('keep'))
    flush()
    expect(store.lines.value.length).toBe(1)
    expect(lineToText(store.lines.value[0])).toBe('keep')
  })

  it('超 scrollbackLimit 裁剪并累计 droppedLines', () => {
    const settings = makeSettings({ scrollbackLimit: 2 })
    const { store, emit } = setup(settings)
    store.setSize(80, 2) // max = 2 + 2 = 4 行
    for (let i = 0; i < 10; i++) emit(enc.encode(`L${i}\r\n`))
    flush()
    expect(store.droppedLines.value).toBeGreaterThan(0)
    expect(store.lines.value.length).toBeLessThanOrEqual(4)
  })

  it('CPR 查询自动应答（D6 回复通道）', () => {
    const { emit, sent } = setup()
    emit(enc.encode('a\r\nb\r\nc\r\nd\r\ne')) // 5 行
    emit(enc.encode('\x1b[5;5H\x1b[6n'))     // 定位第 5 行第 5 列后查询
    flush()
    expect(new TextDecoder().decode(sent[0])).toBe('\x1b[5;5R')
  })
})

describe('terminal store · 发送与回显', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sendBytes 原始下发（record=false 不建 TX 气泡）', async () => {
    const { store, sent } = setup()
    const r = await store.sendBytes(new Uint8Array([0x68, 0x69]))
    expect(r.ok).toBe(true)
    expect(sent[0]).toEqual(new Uint8Array([0x68, 0x69]))
  })

  it('injectLocal 本地回显到视口（echo 策略在组件层）', () => {
    const { store } = setup()
    store.injectLocal(enc.encode('help\r\n'))
    flush()
    expect(lineToText(store.lines.value[0])).toBe('help')
  })

  it('scrollbackText 导出无样式纯文本', () => {
    const { store, emit } = setup()
    emit(enc.encode('\x1b[31mred\x1b[0m\r\ngreen'))
    flush()
    expect(store.scrollbackText()).toBe('red\ngreen')
  })
})
