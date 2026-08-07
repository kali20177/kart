import { describe, it, expect } from 'vitest'
import { ScreenBuffer, snapshotShared, snapshotDeep, lineToSegments, lineToText } from './screen-buffer'

function make(cols = 80, rows = 24, scrollbackLimit = 1000): ScreenBuffer {
  return new ScreenBuffer(cols, rows, scrollbackLimit)
}

describe('ScreenBuffer · 基本打印与光标', () => {
  it('print 逐字符放置并前进光标', () => {
    const b = make()
    b.print('hi')
    expect(lineToText(b.getLines()[0])).toBe('hi')
    expect(b.getCursor()).toEqual({ line: 0, col: 2 })
  })

  it('达到列宽自动换行并滚动到下一行', () => {
    const b = make(4, 24)
    b.print('abcde')
    expect(b.getLineCount()).toBe(2)
    expect(lineToText(b.getLines()[0])).toBe('abcd')
    expect(lineToText(b.getLines()[1])).toBe('e')
    expect(b.getCursor().line).toBe(1)
  })

  it('CR 回到行首覆盖已有内容（readline 重绘语义）', () => {
    const b = make()
    b.print('hello')
    b.carriageReturn()
    b.print('HE')
    expect(lineToText(b.getLines()[0])).toBe('HEllo')
  })

  it('LF 换行到新行，列回到 0', () => {
    const b = make()
    b.print('a')
    b.lineFeed()
    b.print('b')
    expect(lineToText(b.getLines()[0])).toBe('a')
    expect(lineToText(b.getLines()[1])).toBe('b')
    expect(b.getCursor().line).toBe(1)
  })

  it('退格移动光标不删除（删除由设备发覆盖序列）', () => {
    const b = make()
    b.print('abc')
    b.backspace()
    expect(b.getCursor()).toEqual({ line: 0, col: 2 })
  })

  it('tab 跳到 8 的倍数列', () => {
    const b = make()
    b.tab()
    expect(b.getCursor().col).toBe(8)
  })
})

describe('ScreenBuffer · 光标寻址', () => {
  it('光标上/下/左/右移动并限制在屏幕区', () => {
    const b = make(80, 3)
    b.print('x')
    b.lineFeed()
    b.lineFeed()
    // 现在 3 行，屏幕区 = 全部
    b.cursorUp(1)
    expect(b.getCursor().line).toBe(1)
    b.cursorDown(2)
    expect(b.getCursor().line).toBe(2)
    b.cursorRight(5)
    expect(b.getCursor().col).toBe(5)
    b.cursorLeft(10)
    expect(b.getCursor().col).toBe(0)
  })

  it('CUP 定位 1-based 行/列', () => {
    const b = make(80, 24)
    b.print('a')
    b.lineFeed()
    b.cursorPos(1, 1) // 回到第 1 行第 1 列
    expect(b.getCursor()).toEqual({ line: 0, col: 0 })
    b.cursorPos(2, 5)
    expect(b.getCursor()).toEqual({ line: 1, col: 4 })
  })

  it('光标上移不越过屏幕顶（进入回滚区的编辑留到阶段三）', () => {
    const b = make(80, 3, 10)
    b.print('r1')
    b.lineFeed(); b.print('r2')
    b.lineFeed(); b.print('r3')
    b.lineFeed(); b.print('r4') // 4 行，屏幕区 = 末尾 3 行
    expect(b.getLineCount()).toBe(4)
    b.cursorUp(10)
    expect(b.getCursor().line).toBe(1) // 屏幕顶 = 4-3 = 1
  })
})

describe('ScreenBuffer · 擦除', () => {
  it('EL 0 擦除光标到行尾', () => {
    const b = make()
    b.print('abcdef')
    b.carriageReturn()
    b.print('ab')
    b.eraseLine(0)
    expect(lineToText(b.getLines()[0])).toBe('ab')
  })

  it('EL 1 擦除行首到光标（保留前导空白）', () => {
    const b = make()
    b.print('abcdef')
    b.carriageReturn()
    b.print('abc')
    b.eraseLine(1)
    expect(lineToText(b.getLines()[0])).toBe('    ef')
  })

  it('ED 2 清屏并把光标移到屏首', () => {
    const b = make(80, 3)
    b.print('a'); b.lineFeed(); b.print('b'); b.lineFeed(); b.print('c')
    b.cursorPos(2, 1)
    b.eraseScreen(2)
    expect(b.getLines().every((l) => lineToText(l) === '')).toBe(true)
    expect(b.getCursor()).toEqual({ line: 0, col: 0 })
  })
})

describe('ScreenBuffer · SGR 颜色', () => {
  it('前景/背景/加粗/重置', () => {
    const b = make()
    b.setSgr([1, 32])
    b.print('G')
    b.setSgr([41])
    b.print('R')
    b.setSgr([0])
    b.print('x')
    const cells = b.getLines()[0].cells
    expect(cells[0]).toEqual({ ch: 'G', fg: '#008000', bg: null, bold: true })
    expect(cells[1]).toEqual({ ch: 'R', fg: '#008000', bg: '#800000', bold: true })
    expect(cells[2]).toEqual({ ch: 'x', fg: null, bg: null, bold: false })
  })

  it('38;5;n 256 色与 38;2;r;g;b 真彩色', () => {
    const b = make()
    b.setSgr([38, 5, 196])
    b.print('A')
    b.setSgr([38, 2, 10, 20, 30])
    b.print('B')
    expect(b.getLines()[0].cells[0].fg).toMatch(/^rgb\(/)
    expect(b.getLines()[0].cells[1].fg).toBe('rgb(10,20,30)')
  })
})

describe('ScreenBuffer · 回滚上限与裁剪', () => {
  it('超过 scrollbackLimit + rows 裁剪头部，dropped 累计、epoch 递增', () => {
    const b = make(10, 3, 2) // 上限 = 2 + 3 = 5 行
    for (let i = 0; i < 8; i++) { b.print(`L${i}`); b.lineFeed() }
    expect(b.getLineCount()).toBe(5)
    expect(b.getDropped()).toBe(4)
    const e0 = b.getEpoch()
    b.lineFeed() // 缓冲已满，再换行触发裁剪 → epoch++
    expect(b.getEpoch()).toBeGreaterThan(e0)
  })

  it('裁剪后光标仍在有效范围', () => {
    const b = make(10, 3, 1)
    for (let i = 0; i < 6; i++) { b.print(`L${i}`); b.lineFeed() }
    const c = b.getCursor()
    expect(c.line).toBeGreaterThanOrEqual(0)
    expect(c.line).toBeLessThan(b.getLineCount())
  })
})

describe('ScreenBuffer · 快照与渲染辅助', () => {
  it('snapshotShared 共享 cells，snapshotDeep 拷贝 cells', () => {
    const b = make()
    b.print('hi')
    const shared = snapshotShared(b.getLines()[0])
    expect(shared.cells).toBe(b.getLines()[0].cells)
    const deep = snapshotDeep(b.getLines()[0])
    expect(deep.cells).not.toBe(b.getLines()[0].cells)
    expect(deep.cells.length).toBe(b.getLines()[0].cells.length)
  })

  it('lineToSegments 合并同样式并标记光标单元格', () => {
    const b = make()
    b.setSgr([31])
    b.print('ab')
    b.setSgr([0])
    b.print('c')
    const segs = lineToSegments(b.getLines()[0], 0)
    expect(segs.length).toBe(3)
    expect(segs[0]).toMatchObject({ text: 'a', fg: '#800000', cursor: true })
    expect(segs[1]).toMatchObject({ text: 'b', fg: '#800000', cursor: false })
    expect(segs[2]).toMatchObject({ text: 'c', fg: null })
  })

  it('getText 导出无样式纯文本', () => {
    const b = make()
    b.setSgr([1, 34])
    b.print('hello')
    b.lineFeed()
    b.print('world')
    expect(b.getText()).toBe('hello\nworld')
  })
})
