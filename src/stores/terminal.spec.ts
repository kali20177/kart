import { describe, it, expect } from 'vitest'
import { ref, nextTick, reactive } from 'vue'
import { createTerminalStore, type TerminalDeps } from './terminal'
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
      fontFamily: 'monospace',
      ...partial,
    },
    autoReconnect: false,
    showPauseNotification: true,
    recordFormat: 'text',
    sendHistoryLimit: 50,
  }
}

function setup(settings?: AppSettings, useUtf8?: boolean) {
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
    useUtf8,
  } as TerminalDeps)
  return { store, emit: (b: Uint8Array) => cb(b), sent, paused }
}

/** xterm 的 term.write 异步处理，等待一帧后 buffer 才更新 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('terminal store · 摄入与渲染（xterm）', () => {
  it('原始字节 → xterm 渲染：SGR 剥色、CR 重绘、多行', async () => {
    const { store, emit } = setup()
    emit(enc.encode('\x1b[1;32mroot@kart:~# \x1b[0m\x1b[31mERR\x1b[0m\r\nok'))
    await flush()
    expect(store.scrollbackText()).toBe('root@kart:~# ERR\nok')
  })

  it('连续输入累计为单行', async () => {
    const { store, emit } = setup()
    emit(enc.encode('hel'))
    await flush()
    expect(store.scrollbackText()).toBe('hel')
    emit(enc.encode('lo'))
    await flush()
    expect(store.scrollbackText()).toBe('hello')
  })

  it('CR 覆盖已有内容（readline 重绘语义）', async () => {
    const { store, emit } = setup()
    emit(enc.encode('hello\rHE'))
    await flush()
    expect(store.scrollbackText()).toBe('HEllo')
  })

  it('clear 清空全部并重置统计', async () => {
    const { store, emit } = setup()
    emit(enc.encode('hello'))
    store.clear()
    await flush()
    expect(store.scrollbackText()).toBe('')
    expect(store.rawDump.value).toBe('')
  })

  it('暂停时丢弃摄入，恢复后继续', async () => {
    const { store, emit, paused } = setup()
    paused.value = true
    emit(enc.encode('drop'))
    await flush()
    expect(store.scrollbackText()).toBe('')
    paused.value = false
    emit(enc.encode('keep'))
    await flush()
    expect(store.scrollbackText()).toBe('keep')
  })

  it('超 scrollback 上限静默裁剪并累计近似 droppedLines', async () => {
    const { store, emit } = setup(makeSettings({ scrollbackLimit: 2 }))
    for (let i = 0; i < 40; i++) emit(enc.encode(`L${i}\r\n`))
    await flush()
    expect(store.droppedLines.value).toBeGreaterThan(0)
    // xterm 容量 = scrollback(2) + 视口 rows(默认 24) = 26 行
    expect(store.scrollbackText().split('\n').length).toBeLessThanOrEqual(26)
  })

  it('rawDump 记录最近原始字节 hex', () => {
    const { store, emit } = setup()
    emit(new Uint8Array([0x41, 0x42, 0x0d, 0x0a]))
    expect(store.rawDump.value).toBe('41 42 0d 0a')
  })

  it('useUtf8=true：编码设为 GBK 时仍按 UTF-8 解码（pty 场景，本地 shell 输出为 UTF-8）', async () => {
    const settings = makeSettings()
    settings.encoding = 'gbk'
    const { store, emit } = setup(settings, true)
    emit(new TextEncoder().encode('串口调试'))
    await flush()
    expect(store.scrollbackText()).toBe('串口调试')
  })

  it('useUtf8 缺省：GBK 编码下 UTF-8 字节被按 GBK 解码成乱码（串口语义，非 pty）', async () => {
    const settings = makeSettings()
    settings.encoding = 'gbk'
    const { store, emit } = setup(settings, false)
    emit(new TextEncoder().encode('串口调试'))
    await flush()
    expect(store.scrollbackText()).not.toBe('串口调试')
  })

  it('fontFamily 初始值应用 + 设置变更热更新到 xterm options', async () => {
    // 生产 settings 为 Pinia reactive proxy，watch 依赖响应式追踪；测试须 reactive 包裹
    const settings = reactive(makeSettings())
    const { store } = setup(settings)
    expect(store.term.options.fontFamily).toBe('monospace')
    settings.terminal.fontFamily = 'Fira Code'
    await nextTick()
    expect(store.term.options.fontFamily).toBe('Fira Code')
  })
})

describe('terminal store · 发送与回显', () => {
  it('sendBytes 原始下发（record=false 不建 TX 气泡）', async () => {
    const { store, sent } = setup()
    const r = await store.sendBytes(new Uint8Array([0x68, 0x69]))
    expect(r.ok).toBe(true)
    expect(sent[0]).toEqual(new Uint8Array([0x68, 0x69]))
  })

  it('char 模式：term.input 按键 → sendRaw（onData 整段合并为一次下发）', () => {
    const { store, sent } = setup()
    store.term.input('abc')
    expect(sent.length).toBe(1)
    expect(new TextDecoder().decode(sent[0])).toBe('abc')
  })

  it('char 模式 Enter 追加所选行尾（crlf → 0D 0A）', () => {
    const { store, sent } = setup()
    store.term.input('\r')
    expect(sent[0]).toEqual(new Uint8Array([0x0d, 0x0a]))
  })

  it('backspace=bs 时 0x7F → 0x08', () => {
    const { store, sent } = setup(makeSettings({ backspace: 'bs' }))
    store.term.input('\x7f')
    expect(sent[0]).toEqual(new Uint8Array([0x08]))
  })

  it('line 模式不发送按键（xterm 输入被 gate）', () => {
    const { store, sent } = setup()
    store.mode.value = 'line'
    store.term.input('abc')
    expect(sent.length).toBe(0)
  })

  it('echo ON：按键回显到视口（本地回显）', async () => {
    const { store, sent } = setup(makeSettings({ echo: true }))
    store.term.input('x')
    expect(sent.length).toBe(1)
    await flush()
    expect(store.scrollbackText()).toBe('x')
  })

  it('echoText 本地回显（line 模式 echo ON 用）', async () => {
    const { store } = setup()
    store.echoText('ls\r\n')
    await flush()
    expect(store.scrollbackText()).toBe('ls')
  })

  it('scrollbackText 导出无样式纯文本', async () => {
    const { store, emit } = setup()
    emit(enc.encode('\x1b[31mred\x1b[0m\r\ngreen'))
    await flush()
    expect(store.scrollbackText()).toBe('red\ngreen')
  })
})
