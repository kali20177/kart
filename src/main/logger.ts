import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import type { LogLevel } from '../types'
import { LEVEL_ORDER, mapConsoleLevel, formatLogLine } from '../utils/log-level'

/** 日志保留天数 */
const RETENTION_DAYS = 30
/** log:read 导出上限（字节）。超出只保留最新尾部——用户回传日志够定位问题即可 */
const READ_MAX_BYTES = 2 * 1024 * 1024

/**
 * 主进程文件日志。按日期轮转（YYYY-MM-DD.log，UTC），保留 30 天。
 * 渲染进程的 console-message 事件也由此转发写入同一目录——Electron 下
 * 这套文件日志是权威来源：主进程事件 + 全部渲染端 console 都在这里，
 * 「导出日志」菜单经 log:read IPC 从这里读取。
 *
 * 健壮性约定：
 * - init() 之前（或日志目录不可用时）写入自动回落 stderr，
 *   保证启动早期的致命错误不会因"日志还没初始化"被静默吞掉；
 * - errorSync() 供 uncaughtException 使用——进程即将退出，异步流来不及刷盘；
 * - WriteStream 的 'error' 事件被接管，磁盘故障不会变成二次未捕获异常。
 */
class MainLogger {
  private logDir = ''
  private minLevel: LogLevel = 'info'
  private stream: fs.WriteStream | null = null
  private currentDate = ''

  init(): void {
    try {
      this.logDir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(this.logDir, { recursive: true })
    } catch {
      this.logDir = ''
    }
    // 启动后异步清理过期日志
    setImmediate(() => this.cleanupOldLogs())
  }

  /** 退出前调用，尽力刷盘 */
  close(): void {
    if (this.stream) {
      try { this.stream.end() } catch { /* */ }
      this.stream = null
    }
  }

  // ─── 文件管理 ───

  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private ensureStream(): void {
    if (!this.logDir) return
    const date = this.today()
    if (date === this.currentDate && this.stream) return
    if (this.stream) { try { this.stream.end() } catch { /* */ } }
    this.currentDate = date
    try {
      this.stream = fs.createWriteStream(path.join(this.logDir, `${date}.log`), { flags: 'a' })
      this.stream.on('error', (err) => {
        // 磁盘满/权限等流级错误：放弃当前流（下次写入重建），避免未监听 'error' 抛二次异常
        process.stderr.write(`[logger] log stream error: ${err.message}\n`)
        this.stream = null
      })
    } catch { this.stream = null }
  }

  private cleanupOldLogs(): void {
    if (!this.logDir) return
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
      for (const f of fs.readdirSync(this.logDir)) {
        if (!f.endsWith('.log')) continue
        const fp = path.join(this.logDir, f)
        const stat = fs.statSync(fp)
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp)
      }
    } catch { /* */ }
  }

  // ─── 写入 ───

  private write(level: LogLevel, context: string, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const line = formatLogLine(new Date().toISOString(), level, context, message)
    this.ensureStream()
    if (this.stream) {
      try { this.stream.write(line); return } catch { /* 落到 stderr 兜底 */ }
    }
    process.stderr.write(line)
  }

  log(level: LogLevel, context: string, message: string): void {
    this.write(level, context, message)
  }

  debug(context: string, message: string): void { this.log('debug', context, message) }
  info(context: string, message: string): void { this.log('info', context, message) }
  warn(context: string, message: string): void { this.log('warn', context, message) }
  error(context: string, message: string): void { this.log('error', context, message) }

  /**
   * 致命错误同步写入（uncaughtException 专用）。
   * 异步 WriteStream 在 process.exit 前来不及刷盘，这里用 appendFileSync，
   * 同时写 stderr 确保即使文件写入失败也在终端留痕。
   */
  errorSync(context: string, message: string): void {
    const line = formatLogLine(new Date().toISOString(), 'error', context, message)
    try { process.stderr.write(line) } catch { /* */ }
    if (this.logDir) {
      try { fs.appendFileSync(path.join(this.logDir, `${this.today()}.log`), line) } catch { /* */ }
    }
  }

  /**
   * 接收 Electron console-message 事件并落文件日志。
   * level 语义见 mapConsoleLevel（0=debug 1=info 2=warn 3=error）。
   */
  handleConsoleMessage(level: number, message: string, line?: number, sourceId?: string): void {
    const loc = sourceId ? ` (${sourceId}:${line ?? 0})` : ''
    this.write(mapConsoleLevel(level), 'renderer', message + loc)
  }

  // ─── 读取（供渲染进程「导出日志」） ───

  /**
   * 读取日志目录下全部 .log 文件，每个文件带 `===== 文件名 =====` 分隔头，
   * 按时间从旧到新返回。总量超过 READ_MAX_BYTES 时只保留最新文件的尾部。
   * 目录不可用返回空数组。
   */
  readAll(): string[] {
    if (!this.logDir) return []
    let names: string[]
    try {
      names = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.log')).sort()
    } catch { return [] }

    const out: string[] = []
    let total = 0
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i]
      let content: string
      try { content = fs.readFileSync(path.join(this.logDir, name), 'utf-8') } catch { continue }
      const header = `===== ${name} =====\n`
      if (total + header.length + content.length > READ_MAX_BYTES) {
        const remain = READ_MAX_BYTES - total - header.length - 32
        if (remain > 1024) {
          out.push(header + '...[older lines truncated]...\n' + content.slice(content.length - remain))
        }
        out.push(`===== 更早的日志已截断，完整日志见 ${this.logDir} =====`)
        break
      }
      out.push(header + content)
      total += header.length + content.length
    }
    return out.reverse()
  }
}

export const mainLogger = new MainLogger()
