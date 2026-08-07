import type { LineEnding } from '@/types'
import { lineEndingBytes } from '@/utils/encoding'

const enc = (s: string) => new TextEncoder().encode(s)

/**
 * 按键事件 → 终端字节序列（char 直通 / line 模式 Ctrl 透传共用）。
 * 返回 null 表示不拦截该键（可打印外的修饰键等，走默认输入）。
 * - Enter → 行尾符；Tab/Backspace/Delete/方向键/Home/End/PageUp/PageDown → 转义序列
 * - Ctrl+字母 → 控制字节（Ctrl+C=0x03 中断等）；其余 Ctrl 组合兜底 0x00
 * - 可打印字符 → 对应 UTF-8 字节（e.key 已含 Shift/大小写）
 */
export function keyToBytes(
  e: { key: string; ctrlKey: boolean },
  backspace: 'del' | 'bs',
  lineEnding: LineEnding
): Uint8Array | null {
  const k = e.key
  switch (k) {
    case 'Enter': return lineEndingBytes(lineEnding)
    case 'Tab': return new Uint8Array([0x09])
    case 'Backspace': return new Uint8Array([backspace === 'bs' ? 0x08 : 0x7f])
    case 'Delete': return enc('\x1b[3~')
    case 'ArrowUp': return enc('\x1b[A')
    case 'ArrowDown': return enc('\x1b[B')
    case 'ArrowRight': return enc('\x1b[C')
    case 'ArrowLeft': return enc('\x1b[D')
    case 'Home': return enc('\x1b[H')
    case 'End': return enc('\x1b[F')
    case 'PageUp': return enc('\x1b[5~')
    case 'PageDown': return enc('\x1b[6~')
  }
  if (e.ctrlKey) {
    const c = k.toUpperCase()
    if (c.length === 1 && c >= 'A' && c <= 'Z') return new Uint8Array([c.charCodeAt(0) - 64])
    if (k === '[') return new Uint8Array([0x1b])
    if (k === '\\') return new Uint8Array([0x1c])
    if (k === ']') return new Uint8Array([0x1d])
    if (k === '^') return new Uint8Array([0x1e])
    if (k === '_') return new Uint8Array([0x1f])
    return new Uint8Array([0x00])
  }
  if (k.length === 1) return enc(k)
  return null
}
