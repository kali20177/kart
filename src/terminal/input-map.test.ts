import { describe, it, expect } from 'vitest'
import { keyToBytes } from './input-map'

const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const key = (key: string, ctrlKey = false) => keyToBytes({ key, ctrlKey }, 'del', 'cr')

describe('keyToBytes · 可打印与行尾', () => {
  it('可打印字符编码为 UTF-8 字节（含大写）', () => {
    expect(dec(key('a'))).toBe('a')
    expect(dec(key('A'))).toBe('A')
    expect(dec(key('1'))).toBe('1')
  })

  it('Enter 追加行尾符（cr → 0x0D）', () => {
    expect(key('Enter')).toEqual(new Uint8Array([0x0d]))
  })

  it('Tab 发送 0x09', () => {
    expect(key('Tab')).toEqual(new Uint8Array([0x09]))
  })

  it('修饰键 / 功能键返回 null（不拦截）', () => {
    expect(key('Shift')).toBeNull()
    expect(key('F1')).toBeNull()
    expect(key('Escape')).toBeNull()
    expect(key('Control')).toBeNull()
  })
})

describe('keyToBytes · 控制键转义序列', () => {
  it('退格 del→0x7F，bs→0x08', () => {
    expect(keyToBytes({ key: 'Backspace', ctrlKey: false }, 'del', 'cr')).toEqual(new Uint8Array([0x7f]))
    expect(keyToBytes({ key: 'Backspace', ctrlKey: false }, 'bs', 'cr')).toEqual(new Uint8Array([0x08]))
  })

  it('方向键 / 功能键转义序列', () => {
    expect(dec(key('ArrowUp'))).toBe('\x1b[A')
    expect(dec(key('ArrowDown'))).toBe('\x1b[B')
    expect(dec(key('ArrowRight'))).toBe('\x1b[C')
    expect(dec(key('ArrowLeft'))).toBe('\x1b[D')
    expect(dec(key('Home'))).toBe('\x1b[H')
    expect(dec(key('End'))).toBe('\x1b[F')
    expect(dec(key('Delete'))).toBe('\x1b[3~')
    expect(dec(key('PageUp'))).toBe('\x1b[5~')
    expect(dec(key('PageDown'))).toBe('\x1b[6~')
  })
})

describe('keyToBytes · Ctrl 控制字节', () => {
  it('Ctrl+字母 → 控制字节', () => {
    expect(key('c', true)).toEqual(new Uint8Array([0x03])) // Ctrl+C 中断
    expect(key('d', true)).toEqual(new Uint8Array([0x04])) // Ctrl+D EOF
    expect(key('z', true)).toEqual(new Uint8Array([0x1a])) // Ctrl+Z 挂起
    expect(key('a', true)).toEqual(new Uint8Array([0x01]))
    expect(key('e', true)).toEqual(new Uint8Array([0x05]))
  })

  it('Ctrl+[ ] \\ ^ _ 对应控制字节', () => {
    expect(key('[', true)).toEqual(new Uint8Array([0x1b]))
    expect(key('\\', true)).toEqual(new Uint8Array([0x1c]))
    expect(key(']', true)).toEqual(new Uint8Array([0x1d]))
    expect(key('^', true)).toEqual(new Uint8Array([0x1e]))
    expect(key('_', true)).toEqual(new Uint8Array([0x1f]))
  })

  it('lineEnding 透传（crlf → 0D 0A）', () => {
    expect(keyToBytes({ key: 'Enter', ctrlKey: false }, 'del', 'crlf')).toEqual(
      new Uint8Array([0x0d, 0x0a])
    )
  })
})
