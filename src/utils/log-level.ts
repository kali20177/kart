/**
 * 日志级别与行格式 —— 渲染端（src/utils/logger.ts）与主进程（src/main/logger.ts）
 * 共用的纯逻辑，无任何框架/DOM/Node 依赖，可单测。
 */
import type { LogLevel } from '../types'

export const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Electron `webContents` 'console-message' 事件的 level 数字到 LogLevel 的映射。
 * 官方定义（electron.d.ts）："The log level, from 0 to 3. In order it matches
 * `verbose`, `info`, `warning` and `error`."
 * 即 0=debug 1=info 2=warn 3=error —— 历史上此处曾把 1/2 写反。
 */
const CONSOLE_LEVEL_MAP: Record<number, LogLevel> = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' }

export function mapConsoleLevel(level: number): LogLevel {
  return CONSOLE_LEVEL_MAP[level] ?? 'info'
}

/** 统一日志行格式：`[ISO时间] [LEVEL] [context] message\n`（两端一致，便于合并阅读） */
export function formatLogLine(timestampIso: string, level: LogLevel, context: string, message: string): string {
  return `[${timestampIso}] [${level.toUpperCase()}] [${context}] ${message}\n`
}

/** 形如 "[context] message" 的首参前缀 -- 渲染端 logger.emit 输出该格式，两端都需从中还原 context */
const CONTEXT_PREFIX = /^\[([^\[\]]{1,32})\]\s*/

export interface SplitContext {
  context: string
  message: string
}

/**
 * 从 "[ctx] msg" 行首提取 context 与剩余 message；无前缀时 context 回落到 fallback。
 * 渲染端劫持 console、主进程接收 console-message 都用它，使两端记录的 context 一致。
 */
export function splitContextLine(line: string, fallback: string): SplitContext {
  const m = CONTEXT_PREFIX.exec(line)
  if (m) return { context: m[1], message: line.slice(m[0].length) }
  return { context: fallback, message: line }
}
