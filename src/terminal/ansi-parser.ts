/**
 * ANSI 转义序列解析器：把解码后的文本流（含控制字符）转为终端操作序列。
 * 纯逻辑类（无定时器、无 DOM），有界状态机（ground / escape / csi / osc / osc-esc），
 * 对畸形序列 / 未知序列一律忽略、绝不抛错。
 *
 * 调用方负责先用流式 TextDecoder（{stream:true}）把字节解码为文本再喂入——
 * 多字节字符跨 chunk 由解码器保留 partial，本解析器只处理完整字符。
 *
 * v1 CSI 子集：光标寻址/移动、列定位、擦除行/屏、SGR、保存恢复、CPR/DA 查询、
 * OSC（忽略内容）。alt-screen / 滚动区域等全屏 TUI 序列解析后忽略（阶段三实现）。
 */

export type TermOp =
  | { t: 'print'; text: string }
  | { t: 'cr' }
  | { t: 'lf' }
  | { t: 'bs' }
  | { t: 'tab' }
  | { t: 'cursor'; kind: 'up' | 'down' | 'left' | 'right'; n: number }
  | { t: 'pos'; row: number; col: number }
  | { t: 'col'; col: number }
  | { t: 'eraseLine'; mode: number }
  | { t: 'eraseScreen'; mode: number }
  | { t: 'sgr'; params: number[] }
  | { t: 'saveCursor' }
  | { t: 'restoreCursor' }
  | { t: 'clear' }
  | { t: 'queryCursor' }
  | { t: 'queryDa'; secondary: boolean }
  | { t: 'osc'; text: string }

type ParserState = 'ground' | 'escape' | 'csi' | 'osc' | 'osc-esc'

const OSC_MAX = 4096

export class AnsiParser {
  private state: ParserState = 'ground'
  private csiParams: number[] = []
  private csiPrivate = ''
  private oscBuf = ''
  private printBuf = ''
  private queue: TermOp[] = []

  /** 喂入一段解码后的文本，返回本次产生的操作序列 */
  push(text: string): TermOp[] {
    for (const ch of text) this.consume(ch)
    this.flushPrint()
    const out = this.queue
    this.queue = []
    return out
  }

  /** 刷新残留在转义态的内容（连接断开 / 收尾时调用） */
  flush(): TermOp[] {
    this.flushPrint()
    const out = this.queue
    this.queue = []
    return out
  }

  private flushPrint(): void {
    if (this.printBuf) {
      this.queue.push({ t: 'print', text: this.printBuf })
      this.printBuf = ''
    }
  }

  private consume(ch: string): void {
    const code = ch.codePointAt(0) ?? 0
    switch (this.state) {
      case 'ground':
        this.ground(code, ch)
        break
      case 'escape':
        this.escape(code, ch)
        break
      case 'csi':
        this.csi(code, ch)
        break
      case 'osc':
        if (code === 0x07) {
          this.queue.push({ t: 'osc', text: this.oscBuf })
          this.oscBuf = ''
          this.state = 'ground'
        } else if (code === 0x1b) {
          this.state = 'osc-esc'
        } else if (this.oscBuf.length < OSC_MAX) {
          this.oscBuf += ch
        }
        break
      case 'osc-esc':
        if (ch === '\\') {
          this.queue.push({ t: 'osc', text: this.oscBuf })
          this.oscBuf = ''
        } else {
          if (this.oscBuf.length < OSC_MAX) this.oscBuf += '\x1b' + ch
        }
        this.state = 'ground'
        break
    }
  }

  private ground(code: number, ch: string): void {
    if (code === 0x1b) {
      this.flushPrint()
      this.state = 'escape'
      return
    }
    if (code === 0x0d) { this.flushPrint(); this.queue.push({ t: 'cr' }); return }
    if (code === 0x0a) { this.flushPrint(); this.queue.push({ t: 'lf' }); return }
    if (code === 0x08) { this.flushPrint(); this.queue.push({ t: 'bs' }); return }
    if (code === 0x09) { this.flushPrint(); this.queue.push({ t: 'tab' }); return }
    // BEL / 其余 C0 控制 / DEL：忽略
    if (code < 0x20 || code === 0x7f) return
    this.printBuf += ch
  }

  private escape(code: number, ch: string): void {
    if (ch === '[') {
      this.state = 'csi'
      this.csiParams = []
      this.csiPrivate = ''
      return
    }
    if (ch === ']') {
      this.state = 'osc'
      this.oscBuf = ''
      return
    }
    if (ch === '7') { this.queue.push({ t: 'saveCursor' }); this.state = 'ground'; return }
    if (ch === '8') { this.queue.push({ t: 'restoreCursor' }); this.state = 'ground'; return }
    if (ch === 'c') { this.queue.push({ t: 'clear' }); this.state = 'ground'; return } // RIS
    void code
    this.state = 'ground' // 其余转义序列（字符集/CSI 无关）忽略
  }

  private csi(code: number, ch: string): void {
    if (ch === '?' || ch === '>' || ch === '!' || ch === '=') {
      this.csiPrivate += ch
      return
    }
    if (code >= 0x30 && code <= 0x39) {
      if (this.csiParams.length === 0) this.csiParams.push(0)
      const last = this.csiParams.length - 1
      this.csiParams[last] = this.csiParams[last] * 10 + (code - 0x30)
      return
    }
    if (ch === ';') {
      this.csiParams.push(0)
      return
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.emitCsi(ch)
      this.state = 'ground'
      return
    }
    // 其余字符：忽略（保持 csi 态继续收集）
  }

  private emitCsi(final: string): void {
    const p = this.csiParams.length > 0 ? this.csiParams : [0]
    const p0 = p[0]
    const priv = this.csiPrivate
    switch (final) {
      case 'A': this.queue.push({ t: 'cursor', kind: 'up', n: p0 || 1 }); return
      case 'B': this.queue.push({ t: 'cursor', kind: 'down', n: p0 || 1 }); return
      case 'C': this.queue.push({ t: 'cursor', kind: 'right', n: p0 || 1 }); return
      case 'D': this.queue.push({ t: 'cursor', kind: 'left', n: p0 || 1 }); return
      case 'H':
      case 'f': this.queue.push({ t: 'pos', row: p[0] || 1, col: p[1] || 1 }); return
      case 'G':
      case '`': this.queue.push({ t: 'col', col: p0 || 1 }); return
      case 'J': this.queue.push({ t: 'eraseScreen', mode: p0 }); return
      case 'K': this.queue.push({ t: 'eraseLine', mode: p0 }); return
      case 'm': this.queue.push({ t: 'sgr', params: this.csiParams }); return
      case 's': this.queue.push({ t: 'saveCursor' }); return
      case 'u': this.queue.push({ t: 'restoreCursor' }); return
      case 'n':
        if (p0 === 6) this.queue.push({ t: 'queryCursor' })
        return
      case 'c':
        this.queue.push({ t: 'queryDa', secondary: priv === '>' })
        return
      default:
        return // 未知 CSI（含私有模式 ?1049h/l、滚动区域 r 等）忽略
    }
  }
}
