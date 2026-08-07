import { describe, it, expect } from 'vitest'
import { AnsiParser } from './ansi-parser'

function parse(...chunks: string[]): ReturnType<AnsiParser['push']> {
  const p = new AnsiParser()
  const ops: ReturnType<AnsiParser['push']> = []
  for (const c of chunks) ops.push(...p.push(c))
  ops.push(...p.flush())
  return ops
}

describe('AnsiParser · 基本文本与控制字符', () => {
  it('可打印字符归并为 print', () => {
    expect(parse('hi')).toEqual([{ t: 'print', text: 'hi' }])
  })

  it('CR / LF / BS / TAB 产生对应操作', () => {
    expect(parse('a\r\n')).toEqual([
      { t: 'print', text: 'a' },
      { t: 'cr' },
      { t: 'lf' },
    ])
    expect(parse('\b\t')).toEqual([{ t: 'bs' }, { t: 'tab' }])
  })

  it('其余 C0 控制与 DEL 忽略', () => {
    expect(parse('\x00\x01\x07\x7f')).toEqual([])
  })
})

describe('AnsiParser · CSI 序列', () => {
  it('光标移动/定位/擦除', () => {
    expect(parse('\x1b[3A')).toEqual([{ t: 'cursor', kind: 'up', n: 3 }])
    expect(parse('\x1b[B')).toEqual([{ t: 'cursor', kind: 'down', n: 1 }])
    expect(parse('\x1b[5;10H')).toEqual([{ t: 'pos', row: 5, col: 10 }])
    expect(parse('\x1b[7G')).toEqual([{ t: 'col', col: 7 }])
    expect(parse('\x1b[2J')).toEqual([{ t: 'eraseScreen', mode: 2 }])
    expect(parse('\x1b[K')).toEqual([{ t: 'eraseLine', mode: 0 }])
  })

  it('SGR 参数透传（含空参数 = 重置）', () => {
    expect(parse('\x1b[m')).toEqual([{ t: 'sgr', params: [] }])
    expect(parse('\x1b[1;32m')).toEqual([{ t: 'sgr', params: [1, 32] }])
  })

  it('CPR / DA 查询', () => {
    expect(parse('\x1b[6n')).toEqual([{ t: 'queryCursor' }])
    expect(parse('\x1b[c')).toEqual([{ t: 'queryDa', secondary: false }])
    expect(parse('\x1b[>c')).toEqual([{ t: 'queryDa', secondary: true }])
  })

  it('保存/恢复光标', () => {
    expect(parse('\x1b7')).toEqual([{ t: 'saveCursor' }])
    expect(parse('\x1b8')).toEqual([{ t: 'restoreCursor' }])
  })

  it('未知 CSI 忽略（alt-screen / 滚动区域 / 鼠标等）', () => {
    expect(parse('\x1b[?1049h\x1b[?2004h\x1b[5;1r')).toEqual([])
  })
})

describe('AnsiParser · 跨 chunk 与容错', () => {
  it('转义序列被拆分到多个 chunk 仍正确解析', () => {
    expect(parse('\x1b[1;', '32', 'mX')).toEqual([
      { t: 'sgr', params: [1, 32] },
      { t: 'print', text: 'X' },
    ])
  })

  it('孤立 ESC 不抛错（flush 丢弃）', () => {
    expect(parse('\x1b')).toEqual([])
  })

  it('OSC 以 BEL 或 ESC \\ 结束，内容被吞掉（osc 操作由 store 忽略）', () => {
    expect(parse('\x1b]0;title\x07x')).toEqual([
      { t: 'osc', text: '0;title' },
      { t: 'print', text: 'x' },
    ])
    expect(parse('\x1b]8;;http://x\x1b\\y')).toEqual([
      { t: 'osc', text: '8;;http://x' },
      { t: 'print', text: 'y' },
    ])
  })

  it('8-bit 转义残留的可见字符按 print 处理', () => {
    expect(parse('ab\x9bcde')).toEqual([{ t: 'print', text: 'ab\x9bcde' }])
  })

  it('畸形参数（多分号/越界）不抛错', () => {
    expect(parse('\x1b[;;;m\x1b[9999999A')).toEqual([
      { t: 'sgr', params: [0, 0, 0] },
      { t: 'cursor', kind: 'up', n: 9999999 },
    ])
  })

  it('任意两点切分，语义与整段一致（跨 chunk 不丢 \\r\\n/控制符）', () => {
    const stream = 'letter:/$ \r\nletter:/$ \r\nletter:/$ \r\nletter:/$ '
    // print 文本拼接（忽略打印分块粒度），其余控制操作按序保留
    const normalize = (ops: ReturnType<AnsiParser['push']>) => {
      let text = ''
      const rest: string[] = []
      for (const op of ops) {
        if (op.t === 'print') text += op.text
        else rest.push(op.t)
      }
      return `${text} ${rest.join(' ')}`
    }
    const p = new AnsiParser()
    const expected = normalize([...p.push(stream), ...p.flush()])
    for (let i = 0; i <= stream.length; i++) {
      for (let j = i; j <= stream.length; j++) {
        const q = new AnsiParser()
        const ops = [...q.push(stream.slice(0, i)), ...q.push(stream.slice(i, j)), ...q.push(stream.slice(j)), ...q.flush()]
        expect(normalize(ops)).toBe(expected)
      }
    }
  })
})
