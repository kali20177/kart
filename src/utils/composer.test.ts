import { describe, expect, it } from 'vitest'
import { applyAsciiInsert, setComposer } from './composer'
import type { AsciiEntry } from './ascii-table'
import type { Session } from '@/session'

/** 仅用到 viewMode/composerText 两个字段，其余字段无需真实构造 */
function fakeSession(): Session {
  return { viewMode: 'ascii', composerText: '' } as unknown as Session
}

const entry = (e: Partial<AsciiEntry>): AsciiEntry =>
  ({ dec: 0, hex: '', oct: '', char: null, name: '', ...e }) as AsciiEntry

describe('applyAsciiInsert', () => {
  it('HEX 模式追加 hex 码，已有内容以空格分隔', () => {
    const s = fakeSession()
    s.viewMode = 'hex'
    applyAsciiInsert(s, entry({ dec: 65, hex: '41' }))
    applyAsciiInsert(s, entry({ dec: 66, hex: '42' }))
    expect(s.composerText).toBe('41 42 ')
  })

  it('ASCII 模式插入可打印字符', () => {
    const s = fakeSession()
    applyAsciiInsert(s, entry({ dec: 65, char: 'A' }))
    expect(s.composerText).toBe('A')
  })

  it('命名转义仅限 CR/LF/Tab/NUL，其余控制字符不插入', () => {
    const s = fakeSession()
    applyAsciiInsert(s, entry({ dec: 13, escape: '\r' }))
    applyAsciiInsert(s, entry({ dec: 27, escape: 'ESC' })) // ESC 不在命名转义集合
    expect(s.composerText).toBe('\r')
  })
})

describe('setComposer', () => {
  it('覆盖草稿并切换显示模式', () => {
    const s = fakeSession()
    setComposer(s, '0xAA', 'hex')
    expect(s.composerText).toBe('0xAA')
    expect(s.viewMode).toBe('hex')
  })
})
