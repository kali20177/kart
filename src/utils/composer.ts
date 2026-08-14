import type { Session } from '@/session'
import type { DataMode } from '@/types'
import type { AsciiEntry } from '@/utils/ascii-table'

/** 命名转义白名单：仅回车/换行/Tab/NUL 有常见转义写法（与旧 SessionPane 内实现一致） */
const NAMED_ESCAPES = new Set([0, 9, 10, 13])

/**
 * 编码器选中项 → 追加到发送框草稿。ASCII 模式插入可打印字符或命名转义；
 * HEX 模式插入两位 hex 码，已有内容时以空格分隔（与 encodeWithEscapes 的语义一致）。
 */
export function applyAsciiInsert(session: Session, entry: AsciiEntry): void {
  if (session.viewMode === 'hex') {
    session.composerText += (session.composerText && !session.composerText.endsWith(' ') ? ' ' : '') + entry.hex + ' '
  } else if (entry.char != null) {
    session.composerText += entry.char
  } else if (entry.escape && NAMED_ESCAPES.has(entry.dec)) {
    session.composerText += entry.escape
  }
}

/** 快速命令「调到发送框」：覆盖草稿并切换显示模式 */
export function setComposer(session: Session, text: string, mode: DataMode): void {
  session.composerText = text
  session.viewMode = mode
}
