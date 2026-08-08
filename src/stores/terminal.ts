import { ref, onScopeDispose, watch, markRaw, type Ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { AppSettings, LineEnding } from '@/types'
import { lineEndingBytes } from '@/utils/encoding'

/** terminal store 的外部依赖——原始字节来自 serial.onData（帧切分之前），
 *  发送走 serial.sendRaw（不追加校验和/不建 TX 气泡），暂停与消息/波形共享同一 paused。
 *  渲染与 ANSI 解析由 xterm.js 承担，本 store 只做「字节 ↔ 终端」的薄桥。 */
export interface TerminalDeps {
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  sendRaw: (bytes: Uint8Array, record?: boolean) => Promise<{ ok: boolean; error?: string }>
  paused: Ref<boolean>
  pauseStartTime: Ref<number>
  settings: AppSettings
}

const enc = (s: string) => new TextEncoder().encode(s)

export function createTerminalStore(deps: TerminalDeps) {
  const s = deps.settings.terminal
  const term = new Terminal({
    scrollback: s.scrollbackLimit,
    fontSize: Math.round(deps.settings.fontSize * s.fontScale),
    allowProposedApi: true,
  })

  // 应用层交互态（TerminalPane 工具栏读写；暂不落盘）
  const mode = ref<'line' | 'char'>(s.transmitMode)
  const echo = ref(s.echo)
  const lineEnding = ref<LineEnding>(s.lineEnding)
  const backspace = ref<'del' | 'bs'>(s.backspace)

  /** 最近接收的原始字节 hex（调试/字节透视；环形保留最近 400 字节） */
  const rawDump = ref('')
  /** 近似丢弃行数：xterm 静默裁剪回滚，用「已写入行数 − 容量」估算 */
  const droppedLines = ref(0)
  const rawRing: number[] = []
  let decoder: TextDecoder | null = null
  let writtenLines = 0
  let capacity = s.scrollbackLimit + term.rows

  const unsubscribe = deps.onData((bytes) => ingest(bytes))

  /** 串口原始字节 → 流式解码 → xterm 渲染（受暂停控制） */
  function ingest(bytes: Uint8Array) {
    if (deps.paused.value) return
    for (const b of bytes) {
      rawRing.push(b)
      if (rawRing.length > 400) rawRing.shift()
    }
    if (!decoder) decoder = new TextDecoder(deps.settings.encoding, { fatal: false })
    const text = decoder.decode(bytes, { stream: true })
    term.write(text)
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) writtenLines++
    const cap = s.scrollbackLimit + term.rows
    if (cap !== capacity) capacity = cap
    droppedLines.value = Math.max(0, writtenLines - capacity)
    rawDump.value = rawRing.map((b) => b.toString(16).padStart(2, '0')).join(' ')
  }

  /** 输入通道：xterm 收到按键 → 字节下发（char 直通；line 模式由组件拦截，此处不处理） */
  term.onData((data) => {
    if (mode.value !== 'char') return
    let bytes: Uint8Array = enc(data)
    if (data === '\r') bytes = lineEndingBytes(lineEnding.value)
    else if (data === '\x7f' && backspace.value === 'bs') bytes = new Uint8Array([0x08])
    if (echo.value) term.write(data)
    void sendBytes(bytes)
  })

  /** 裸下发（终端路径不建 TX 气泡；本地回显策略由组件层决定） */
  async function sendBytes(bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
    return deps.sendRaw(bytes, false)
  }

  /** 本地回显到视口（line 模式 echo ON 用） */
  function echoText(text: string) {
    term.write(text)
  }

  /** 清空：清屏 + 清回滚 + 重置统计 */
  function clear() {
    decoder = null
    rawRing.length = 0
    rawDump.value = ''
    writtenLines = 0
    droppedLines.value = 0
    term.write('\x1b[2J\x1b[3J\x1b[H')
  }

  /** 全量回滚文本（复制全部 / 导出用；xterm 内部换行语义，裁剪预填充的空白行） */
  function scrollbackText(): string {
    const buffer = term.buffer.active
    const parts: string[] = []
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      if (parts.length > 0 && !line.isWrapped) parts.push('\n')
      parts.push(line.translateToString(true))
    }
    return parts.join('').replace(/^\n+/, '').replace(/\n+$/, '')
  }

  /** 更新视口尺寸（容器 resize 后调用；FitAddon 通常自动处理） */
  function setSize(cols: number, rows: number) {
    term.resize(cols, rows)
  }

  // 设置变更热更新到 xterm 选项
  watch(
    () => deps.settings.terminal.scrollbackLimit,
    (n) => { term.options.scrollback = n }
  )
  watch(
    () => deps.settings.fontSize * deps.settings.terminal.fontScale,
    (n) => { term.options.fontSize = Math.round(n) }
  )

  onScopeDispose(() => {
    unsubscribe()
    term.dispose()
  })

  return {
    term: markRaw(term),
    mode,
    echo,
    lineEnding,
    backspace,
    rawDump,
    droppedLines,
    paused: deps.paused,
    sendBytes,
    echoText,
    clear,
    scrollbackText,
    setSize,
    ingest,
  }
}
