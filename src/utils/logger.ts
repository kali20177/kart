import type { LogLevel } from '@/types'
import { LEVEL_ORDER } from './log-level'
import { downloadTextFile } from './download'

/** 一条持久化的日志记录。context 单独存字段，message 不再内嵌 [context] 前缀 */
export interface LogEntry {
  timestamp: number
  level: LogLevel
  context: string
  message: string
  data?: string
}

interface OrigConsole {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const DB_NAME = 'kart-logs'
const STORE = 'entries'
const MAX_ENTRIES = 10_000
/** 超过该水位才触发裁剪，避免贴近上限频繁 count+trim */
const TRIM_WATERMARK = 12_000

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        s.createIndex('ts', 'timestamp', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function formatData(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}\n${data.stack ?? ''}`
  if (data instanceof Uint8Array) return `[${data.join(', ')}]`
  try { return JSON.stringify(data) } catch { return String(data) }
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 形如 "[serial] xxx" 的首参前缀 —— 用于从 console 调用中提取 context */
const CONTEXT_PREFIX = /^\[([^\[\]]{1,32})\]\s*/

export class Logger {
  private db: IDBDatabase | null = null
  private minLevel: LogLevel = 'info'
  private origConsole: OrigConsole
  private hijacked = false
  private handlersRegistered = false
  private approxCount = 0
  private trimming = false
  /** 导出时附在文件头的环境信息（版本/平台/驱动等，便于开发者定位问题） */
  private env: Record<string, string> = {}

  constructor() {
    // 在劫持前保存原始 console 引用，避免 wrapper 层无限递归
    this.origConsole = {
      debug: console.debug.bind(console),
      info: console.info.bind(console),
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    }
  }

  async init(level: LogLevel = 'info'): Promise<void> {
    this.minLevel = level
    try {
      this.db = await openDB()
      this.approxCount = await this.countEntries()
      if (this.approxCount > MAX_ENTRIES) this.scheduleTrim()
    } catch {
      this.db = null // IDB 不可用，静默降级
    }
  }

  /** 登记环境信息，导出日志时附在文件头（版本、平台、驱动类型等） */
  setEnv(key: string, value: string): void {
    this.env[key] = value
  }

  // ─── 核心写入 ───

  log(level: LogLevel, context: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const body = message + (data !== undefined ? ' ' + formatData(data) : '')
    this.emit(level, context, body)
  }

  debug(context: string, message: string, data?: unknown): void { this.log('debug', context, message, data) }
  info(context: string, message: string, data?: unknown): void { this.log('info', context, message, data) }
  warn(context: string, message: string, data?: unknown): void { this.log('warn', context, message, data) }
  error(context: string, message: string, data?: unknown): void { this.log('error', context, message, data) }

  /** 落 IDB + 输出到原始 console（Electron 下经 console-message 事件进入主进程文件日志） */
  private emit(level: LogLevel, context: string, message: string): void {
    this.store({ timestamp: Date.now(), level, context, message })
    const line = `[${context}] ${message}`
    switch (level) {
      case 'debug': this.origConsole.debug(line); break
      case 'info': this.origConsole.log(line); break
      case 'warn': this.origConsole.warn(line); break
      case 'error': this.origConsole.error(line); break
    }
  }

  // ─── IDB 持久化 ───

  private store(entry: LogEntry): void {
    if (!this.db) return
    try {
      const tx = this.db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).add(entry)
      this.approxCount++
      if (this.approxCount > TRIM_WATERMARK) this.scheduleTrim()
    } catch { /* IDB 不可用（如配额满）*/ }
  }

  private scheduleTrim(): void {
    if (this.trimming || !this.db) return
    this.trimming = true
    this.trimExcess().finally(() => { this.trimming = false })
  }

  private countEntries(): Promise<number> {
    return new Promise<number>((resolve) => {
      if (!this.db) { resolve(0); return }
      try {
        const req = this.db.transaction(STORE, 'readonly').objectStore(STORE).count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(0)
      } catch { resolve(0) }
    })
  }

  private async trimExcess(): Promise<void> {
    if (!this.db) return
    try {
      const count = await this.countEntries()
      if (count <= MAX_ENTRIES) {
        this.approxCount = count
        return
      }

      const wtx = this.db.transaction(STORE, 'readwrite')
      const s = wtx.objectStore(STORE)
      const idx = s.index('ts')
      const cursor = idx.openCursor()
      let deleted = 0
      const target = count - MAX_ENTRIES
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          if (!cursor.result || deleted >= target) { resolve(); return }
          s.delete(cursor.result.primaryKey)
          deleted++
          cursor.result.continue()
        }
        cursor.onerror = () => reject(cursor.error)
      })
      this.approxCount = MAX_ENTRIES
    } catch { /* 裁剪失败不影响主流程 */ }
  }

  // ─── 控制台劫持 ───

  /** 劫持 console.* 使所有现存的 console 调用自动写入日志存储 */
  hijackConsole(): void {
    if (this.hijacked) return
    this.hijacked = true

    const mapLevel = (method: string): LogLevel =>
      method === 'warn' ? 'warn' : method === 'error' ? 'error' : method === 'debug' ? 'debug' : 'info'

    ;(['debug', 'info', 'log', 'warn', 'error'] as const).forEach(method => {
      const orig = (console as unknown as Record<string, (...args: unknown[]) => void>)[method]
      // 箭头函数：wrapper 不需要自己的 this，orig 已在构造函数中 bind(console)
      ;(console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
        const level = mapLevel(method)
        // 低于阈值的 console 调用（如三方库 debug 刷屏）不落盘，直接透传
        if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) {
          // 从首参 "[xxx] ..." 前缀提取 context，并从 message 中剥掉前缀避免导出重复
          let context = 'app'
          let parts = args
          const s0 = typeof args[0] === 'string' ? args[0] : ''
          const m = CONTEXT_PREFIX.exec(s0)
          if (m) {
            context = m[1]
            parts = [s0.slice(m[0].length), ...args.slice(1)]
          }
          const message = parts.map(a => safeStringify(a)).join(' ').trim()
          if (message) {
            this.store({ timestamp: Date.now(), level, context, message })
          }
        }
        orig(...args)
      }
    })
  }

  // ─── 全局错误兜底 ───

  /** 注册 window.onerror / unhandledrejection（幂等） */
  registerGlobalHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true

    window.addEventListener('error', (event) => {
      this.store({
        timestamp: Date.now(),
        level: 'error',
        context: 'window',
        message: `${event.message} @ ${event.filename}:${event.lineno}`,
        data: event.error?.stack ?? undefined,
      })
    })

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      this.store({
        timestamp: Date.now(),
        level: 'error',
        context: 'promise',
        message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
        data: reason instanceof Error ? reason.stack : undefined,
      })
    })
  }

  // ─── 导出 ───

  private buildExportHeader(): string {
    const lines = ['===== KART Log Export =====', `exportedAt: ${new Date().toISOString()}`]
    for (const [k, v] of Object.entries(this.env)) lines.push(`${k}: ${v}`)
    lines.push('===========================')
    return lines.join('\n')
  }

  /** 将 IDB 中持久化的日志格式化为纯文本（浏览器环境的导出来源） */
  private async exportFromIdb(): Promise<string> {
    if (!this.db) return ''
    try {
      const tx = this.db.transaction(STORE, 'readonly')
      const entries = await new Promise<LogEntry[]>((resolve, reject) => {
        const req = tx.objectStore(STORE).getAll()
        req.onsuccess = () => resolve(req.result as LogEntry[])
        req.onerror = () => reject(req.error)
      })
      const fmt = (ts: number) => new Date(ts).toISOString()
      return entries.map(e =>
        `[${fmt(e.timestamp)}] [${e.level.toUpperCase()}] [${e.context}] ${e.message}${e.data ? '\n    ' + e.data : ''}`
      ).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * 导出并下载日志文件。
   * - Electron：优先取主进程文件日志（权威来源——含主进程事件与全部渲染端 console），
   *   读不到时回落 IDB；
   * - 浏览器：从 IDB 导出。
   * 返回导出行数（0 = 无日志可导出）。
   */
  async downloadExport(): Promise<number> {
    let body = ''
    try {
      const files = await window.electron?.log?.read()
      if (files && files.length > 0) body = files.join('\n')
    } catch { /* IPC 失败，回落 IDB */ }
    if (!body) body = await this.exportFromIdb()
    if (!body) return 0

    const text = this.buildExportHeader() + '\n' + body
    const date = new Date().toISOString().slice(0, 10)
    downloadTextFile(`kart-logs-${date}.log`, text)
    return text.split('\n').filter(Boolean).length
  }
}

/** 渲染进程全局 Logger 单例 */
export const logger = new Logger()
