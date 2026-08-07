/**
 * 终端屏幕缓冲：把终端操作序列应用到 cell 网格，维护光标 / 换行 / 滚动 / 回滚区。
 * 纯逻辑类（无定时器、无 DOM），便于单测。
 *
 * 模型：
 *  - `lines`：全部逻辑行（回滚区 + 屏幕区），新行追加在末尾，超过上限从头部裁剪。
 *  - 屏幕区 = lines 末尾的 `rows` 行；光标寻址（CUP/CUU 等）以屏幕区为参照。
 *  - 每行是 TermLine（cells + rev），行对象原地变更；`consumeDirty()` 返回本轮改动过的
 *    绝对行号，由 store 在 rAF flush 时对 dirty 行做深快照（新对象身份）触发「仅该行重渲染」。
 *  - 裁剪（trim）会平移绝对行号，故以 `epoch` 标记：trim 后 epoch++，store 见 epoch 变化即整表重建。
 */

export interface TermCell {
  /** 显示的字符（可为空串表示已擦除） */
  ch: string
  /** 前景色 CSS（null = 默认） */
  fg: string | null
  /** 背景色 CSS（null = 默认） */
  bg: string | null
  bold: boolean
}

export interface TermLine {
  /** 行唯一自增 key（虚拟滚动 key-field；裁剪后仍唯一） */
  key: number
  cells: TermCell[]
  /** 修改版本号（诊断用；渲染以对象身份为准） */
  rev: number
}

export interface TermStyle {
  fg: string | null
  bg: string | null
  bold: boolean
}

export interface TermSegment {
  text: string
  fg: string | null
  bg: string | null
  bold: boolean
  /** 该片段包含光标单元格（渲染为块状光标） */
  cursor: boolean
}

const EMPTY_STYLE: TermStyle = { fg: null, bg: null, bold: false }

function blankCell(): TermCell {
  return { ch: '', fg: null, bg: null, bold: false }
}

let nextLineKey = 1

function makeLine(): TermLine {
  return { key: nextLineKey++, cells: [], rev: 0 }
}

/** 深快照：复制 cells 数组（新对象身份 → 触发该行重渲染） */
export function snapshotDeep(line: TermLine): TermLine {
  return { key: line.key, cells: line.cells.slice(), rev: line.rev }
}

/** 浅快照：共享 cells 数组（新对象身份，但内容与 buffer 同步；渲染轻量） */
export function snapshotShared(line: TermLine): TermLine {
  return { key: line.key, cells: line.cells, rev: line.rev }
}

/** 把一行拆成「连续同样式」的片段（供 DOM 渲染；cursorCol 命中的单元格打 cursor 标记） */
export function lineToSegments(line: TermLine, cursorCol: number | null): TermSegment[] {
  const segs: TermSegment[] = []
  const n = Math.max(line.cells.length, cursorCol != null ? cursorCol + 1 : 0)
  let cur: TermSegment | null = null
  for (let i = 0; i < n; i++) {
    const cell = line.cells[i]
    const ch = cell ? (cell.ch || ' ') : ' '
    const fg = cell ? cell.fg : null
    const bg = cell ? cell.bg : null
    const bold = cell ? cell.bold : false
    const cursor = cursorCol != null && i === cursorCol
    if (cursor) {
      if (cur && cur.text) segs.push(cur)
      segs.push({ text: ch, fg, bg, bold, cursor: true })
      cur = null
    } else if (cur && cur.fg === fg && cur.bg === bg && cur.bold === bold) {
      cur.text += ch
    } else {
      if (cur && cur.text) segs.push(cur)
      cur = { text: ch, fg, bg, bold, cursor: false }
    }
  }
  if (cur && cur.text) segs.push(cur)
  return segs
}

/** 把整行转为纯文本（复制/导出用；空 cell 以空格呈现，剥样式） */
export function lineToText(line: TermLine): string {
  return line.cells.map((c) => c.ch || ' ').join('').replace(/\s+$/, '')
}

export class ScreenBuffer {
  private lines: TermLine[] = []
  private cur = 0
  private col = 0
  private style: TermStyle = { ...EMPTY_STYLE }
  private dirty = new Set<number>()
  private epoch = 0
  private dropped = 0
  private saved: { cur: number; col: number; style: TermStyle } | null = null

  constructor(
    private cols: number,
    private rows: number,
    private scrollbackLimit: number
  ) {
    this.lines.push(makeLine())
  }

  /** 更新尺寸（容器 resize 后调用；不做历史行重排，仅影响后续行为） */
  setSize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.col = Math.min(this.col, this.cols - 1)
  }

  setScrollbackLimit(n: number): void {
    this.scrollbackLimit = Math.max(0, n)
    this.trim()
  }

  /** 供渲染：原始行数组（store 据此构建响应式快照） */
  getLines(): TermLine[] {
    return this.lines
  }

  getLineCount(): number {
    return this.lines.length
  }

  /** 本轮被改动的绝对行号（消费后清空） */
  consumeDirty(): Set<number> {
    const d = this.dirty
    this.dirty = new Set()
    return d
  }

  /** 裁剪纪元：trim/clear 后递增，store 据此整表重建（行号已平移） */
  getEpoch(): number {
    return this.epoch
  }

  getDropped(): number {
    return this.dropped
  }

  /** 当前光标：绝对行号 + 列 */
  getCursor(): { line: number; col: number } {
    return { line: this.cur, col: this.col }
  }

  /** 屏幕区光标位置（1-based，供 CPR 应答 ESC[<row>;<col>R） */
  getCursorScreen(): { row: number; col: number } {
    return { row: this.cur - this.screenTop() + 1, col: this.col + 1 }
  }

  private screenTop(): number {
    return Math.max(0, this.lines.length - this.rows)
  }

  private ensureCur(): void {
    if (this.cur < 0) this.cur = 0
    if (this.cur >= this.lines.length) this.cur = this.lines.length - 1
    const top = this.screenTop()
    if (this.cur < top) this.cur = top
  }

  private touch(i: number): void {
    this.dirty.add(i)
    this.lines[i].rev++
  }

  private markAllDirty(): void {
    for (let i = 0; i < this.lines.length; i++) this.dirty.add(i)
  }

  private newLine(): void {
    this.lines.push(makeLine())
    this.cur = this.lines.length - 1
    this.trim()
  }

  /** 超过 scrollbackLimit + rows 时从头部裁剪；trim 平移行号 → epoch++ 触发整表重建 */
  private trim(): void {
    const max = this.scrollbackLimit + this.rows
    let dropped = 0
    while (this.lines.length > max) {
      this.lines.shift()
      dropped++
    }
    if (dropped > 0) {
      this.dropped += dropped
      this.cur = Math.max(this.cur - dropped, 0)
      this.epoch++
      this.markAllDirty()
    }
  }

  private place(ch: string): void {
    this.ensureCur()
    const cells = this.lines[this.cur].cells
    while (cells.length <= this.col) cells.push(blankCell())
    cells[this.col] = { ch, fg: this.style.fg, bg: this.style.bg, bold: this.style.bold }
    this.touch(this.cur)
    this.col++
  }

  /** 打印一段文本（自动换行 / 滚动） */
  print(text: string): void {
    for (const ch of text) {
      if (this.col >= this.cols) {
        if (this.cur === this.lines.length - 1) this.newLine()
        else this.cur++
        this.col = 0
      }
      this.place(ch)
    }
  }

  carriageReturn(): void {
    this.col = 0
  }

  /** 换行：向下移动一行（已在末行则追加）；列回到 0 */
  lineFeed(): void {
    this.ensureCur()
    if (this.cur === this.lines.length - 1) this.newLine()
    else this.cur++
    this.col = 0
  }

  backspace(): void {
    this.col = Math.max(0, this.col - 1)
  }

  tab(): void {
    this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8)
  }

  cursorUp(n: number): void {
    this.ensureCur()
    this.cur = Math.max(this.screenTop(), this.cur - Math.max(1, n))
  }

  cursorDown(n: number): void {
    this.ensureCur()
    this.cur = Math.min(this.lines.length - 1, this.cur + Math.max(1, n))
  }

  cursorLeft(n: number): void {
    this.col = Math.max(0, this.col - Math.max(1, n))
  }

  cursorRight(n: number): void {
    this.col = Math.min(this.cols - 1, this.col + Math.max(1, n))
  }

  /** 光标绝对定位（CUP：row/col 均为 1-based，默认 1;1） */
  cursorPos(row1: number, col1: number): void {
    this.ensureCur()
    const top = this.screenTop()
    const row = Math.min(this.lines.length - 1, top + Math.max(1, row1) - 1)
    this.cur = Math.max(top, row)
    this.col = Math.min(this.cols - 1, Math.max(1, col1) - 1)
  }

  /** 光标列定位（CHA：1-based） */
  cursorCol(col1: number): void {
    this.col = Math.min(this.cols - 1, Math.max(1, col1) - 1)
  }

  /** 擦除行：mode 0=光标到行尾 / 1=行首到光标 / 2=整行（仅清已有 cell，不扩充） */
  eraseLine(mode: number): void {
    this.ensureCur()
    const cells = this.lines[this.cur].cells
    if (cells.length === 0) return
    let from: number
    let to: number
    if (mode === 1) { from = 0; to = Math.min(this.col, cells.length - 1) }
    else if (mode === 2) { from = 0; to = cells.length - 1 }
    else { from = this.col; to = cells.length - 1 }
    if (from > to) return
    for (let i = from; i <= to; i++) cells[i] = blankCell()
    this.touch(this.cur)
  }

  /** 擦除屏幕：mode 0=光标到屏尾 / 1=屏首到光标 / 2=整屏 */
  eraseScreen(mode: number): void {
    const top = this.screenTop()
    if (mode === 2) {
      for (let i = top; i < this.lines.length; i++) {
        this.lines[i].cells = []
        this.touch(i)
      }
      this.cur = top
      this.col = 0
      return
    }
    if (mode === 0) {
      this.eraseLine(0)
      for (let i = this.cur + 1; i < this.lines.length; i++) {
        this.lines[i].cells = []
        this.touch(i)
      }
    } else {
      this.eraseLine(1)
      for (let i = top; i < this.cur; i++) {
        this.lines[i].cells = []
        this.touch(i)
      }
    }
  }

  /** SGR：解析 ANSI 前景/背景/加粗/重置。38;5;n 与 38;2;r;g;b 亦支持 */
  setSgr(params: number[]): void {
    const p = params.length === 0 ? [0] : params
    let i = 0
    while (i < p.length) {
      const n = p[i]
      if (n === 0) {
        this.style = { ...EMPTY_STYLE }
      } else if (n === 1) {
        this.style.bold = true
      } else if (n === 22) {
        this.style.bold = false
      } else if (n === 39) {
        this.style.fg = null
      } else if (n === 49) {
        this.style.bg = null
      } else if (n >= 30 && n <= 37) {
        this.style.fg = ANSI16[n - 30]
      } else if (n >= 90 && n <= 97) {
        this.style.fg = ANSI16[8 + (n - 90)]
      } else if (n >= 40 && n <= 47) {
        this.style.bg = ANSI16[n - 40]
      } else if (n >= 100 && n <= 107) {
        this.style.bg = ANSI16[8 + (n - 100)]
      } else if (n === 38 || n === 48) {
        const target = n === 38 ? 'fg' : 'bg'
        const next = p[i + 1]
        if (next === 5) {
          const idx = p[i + 2]
          if (idx !== undefined) {
            this.style[target] = ansi256ToCss(idx)
            i += 2
          }
        } else if (next === 2) {
          const r = p[i + 2]
          const g = p[i + 3]
          const b = p[i + 4]
          if (r !== undefined && g !== undefined && b !== undefined) {
            this.style[target] = `rgb(${r},${g},${b})`
            i += 4
          }
        }
      }
      i++
    }
  }

  saveCursor(): void {
    this.ensureCur()
    this.saved = { cur: this.cur, col: this.col, style: { ...this.style } }
  }

  restoreCursor(): void {
    if (!this.saved) return
    this.cur = this.saved.cur
    this.col = this.saved.col
    this.style = { ...this.saved.style }
  }

  /** 清空全部（连接/手动清空） */
  clear(): void {
    this.lines = [makeLine()]
    this.cur = 0
    this.col = 0
    this.style = { ...EMPTY_STYLE }
    this.dropped = 0
    this.epoch++
    this.markAllDirty()
  }

  /** 全量回滚文本（复制全部 / 导出用） */
  getText(): string {
    return this.lines.map(lineToText).join('\n')
  }
}

const ANSI16 = [
  '#000000', '#800000', '#008000', '#808000',
  '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00',
  '#0000ff', '#ff00ff', '#00ffff', '#ffffff'
]

/** xterm 256 色索引 → CSS 颜色（0-15 用标准 16 色，16-231 用 6×6×6 立方，232-255 用灰阶） */
export function ansi256ToCss(idx: number): string {
  if (idx < 16) return ANSI16[idx]
  if (idx < 232) {
    const v = (x: number) => Math.round((Math.max(0, x) * 255) / 5)
    const i = idx - 16
    return `rgb(${v(Math.floor(i / 36) % 6)},${v(Math.floor(i / 6) % 6)},${v(i % 6)})`
  }
  const gray = 8 + (idx - 232) * 10
  return `rgb(${gray},${gray},${gray})`
}
