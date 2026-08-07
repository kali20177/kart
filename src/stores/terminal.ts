import { ref, shallowRef, triggerRef, onScopeDispose, type Ref } from 'vue'
import type { AppSettings } from '@/types'
import { AnsiParser, type TermOp } from '@/terminal/ansi-parser'
import { ScreenBuffer, snapshotDeep, snapshotShared, type TermLine } from '@/terminal/screen-buffer'

/** terminal store 的外部依赖——原始字节来自 serial.onData（帧切分之前），
 *  发送走 serial.sendRaw（不追加校验和/不建 TX 气泡），暂停与消息/波形共享同一 paused。 */
export interface TerminalDeps {
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  sendRaw: (bytes: Uint8Array, record?: boolean) => Promise<{ ok: boolean; error?: string }>
  paused: Ref<boolean>
  pauseStartTime: Ref<number>
  settings: AppSettings
}

export function createTerminalStore(deps: TerminalDeps) {
  const lines = shallowRef<TermLine[]>([])
  const cursor = ref({ line: 0, col: 0 })
  const droppedLines = ref(0)
  const paused = deps.paused
  /** 最近接收的原始字节 hex（调试/字节透视；环形保留最近 400 字节） */
  const rawDump = ref('')

  const buffer = new ScreenBuffer(80, 24, deps.settings.terminal.scrollbackLimit)
  const parser = new AnsiParser()
  let decoder: TextDecoder | null = null
  let lastEpoch = 0
  let rafHandle: number | null = null
  const rawRing: number[] = []

  const unsubscribe = deps.onData((bytes) => ingest(bytes))

  /** 把原始字节解码后喂入解析器并应用（受暂停控制；本地回显走 injectLocal 不受限） */
  function ingest(bytes: Uint8Array) {
    if (paused.value) return
    for (const b of bytes) {
      rawRing.push(b)
      if (rawRing.length > 400) rawRing.shift()
    }
    if (!decoder) decoder = new TextDecoder(deps.settings.encoding, { fatal: false })
    const text = decoder.decode(bytes, { stream: true })
    applyOps(parser.push(text))
    scheduleFlush()
  }

  /** 本地回显 / 注入：始终按 UTF-8 解码（本端自己编码的字节），不受暂停控制 */
  function injectLocal(bytes: Uint8Array) {
    const text = new TextDecoder().decode(bytes)
    applyOps(parser.push(text))
    scheduleFlush()
  }

  function applyOps(ops: TermOp[]) {
    for (const op of ops) applyOp(op)
  }

  function applyOp(op: TermOp) {
    switch (op.t) {
      case 'print': buffer.print(op.text); break
      case 'cr': buffer.carriageReturn(); break
      case 'lf': buffer.lineFeed(); break
      case 'bs': buffer.backspace(); break
      case 'tab': buffer.tab(); break
      case 'cursor':
        if (op.kind === 'up') buffer.cursorUp(op.n)
        else if (op.kind === 'down') buffer.cursorDown(op.n)
        else if (op.kind === 'left') buffer.cursorLeft(op.n)
        else buffer.cursorRight(op.n)
        break
      case 'pos': buffer.cursorPos(op.row, op.col); break
      case 'col': buffer.cursorCol(op.col); break
      case 'eraseLine': buffer.eraseLine(op.mode); break
      case 'eraseScreen': buffer.eraseScreen(op.mode); break
      case 'sgr': buffer.setSgr(op.params); break
      case 'saveCursor': buffer.saveCursor(); break
      case 'restoreCursor': buffer.restoreCursor(); break
      case 'clear': buffer.clear(); break
      case 'queryCursor': respondCursor(); break
      case 'queryDa': respondDa(op.secondary); break
      case 'osc': break
    }
  }

  /** CPR 应答：ESC[<row>;<col>R（vim 等全屏程序查询终端尺寸用，见设计 D6） */
  function respondCursor() {
    const { row, col } = buffer.getCursorScreen()
    void deps.sendRaw(new TextEncoder().encode(`\x1b[${row};${col}R`), false)
  }

  /** DA 应答：DA1=VT102 兼容；DA2（> 前缀）=xterm 版本查询，保守回 0 */
  function respondDa(secondary: boolean) {
    const resp = secondary ? '\x1b[>0;0;0c' : '\x1b[?1;2c'
    void deps.sendRaw(new TextEncoder().encode(resp), false)
  }

  function scheduleFlush() {
    if (rafHandle != null) return
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    rafHandle = raf(() => {
      rafHandle = null
      flush()
    })
  }

  /** rAF 合并刷入：只对 dirty/新增行做深快照（新对象身份），未变行保留身份不重渲染。
   *  裁剪/清空（epoch 变化或行数回缩）时整表重建（行号已平移）。 */
  function flush() {
    const bufLines = buffer.getLines()
    const dirty = buffer.consumeDirty()
    const oldLen = lines.value.length
    if (buffer.getEpoch() !== lastEpoch || bufLines.length < oldLen) {
      lastEpoch = buffer.getEpoch()
      lines.value = bufLines.map(snapshotShared)
    } else {
      const arr = lines.value.slice()
      for (let i = oldLen; i < bufLines.length; i++) arr.push(snapshotShared(bufLines[i]))
      for (const i of dirty) if (i < oldLen) arr[i] = snapshotDeep(bufLines[i])
      lines.value = arr
    }
    cursor.value = buffer.getCursor()
    droppedLines.value = buffer.getDropped()
    rawDump.value = rawRing.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    triggerRef(lines)
  }

  /** 更新视口尺寸（容器 resize 时调用；0 = 跟随容器由组件计算实际值传入） */
  function setSize(cols: number, rows: number) {
    buffer.setSize(cols, rows)
  }

  function clear() {
    parser.flush()
    decoder = null
    rawRing.length = 0
    rawDump.value = ''
    buffer.clear()
    flush()
  }

  /** 全量回滚文本（复制全部 / 导出用） */
  function scrollbackText(): string {
    return buffer.getText()
  }

  /** 发送原始字节（终端路径不建 TX 气泡；本地回显策略由组件层决定，经 injectLocal 实现） */
  async function sendBytes(bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
    return deps.sendRaw(bytes, false)
  }

  onScopeDispose(() => {
    unsubscribe()
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
  })

  return {
    lines,
    cursor,
    droppedLines,
    paused,
    rawDump,
    setSize,
    clear,
    scrollbackText,
    sendBytes,
    ingest,
    injectLocal,
  }
}
