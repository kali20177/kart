import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { mainLogger } from './logger'

/**
 * 主进程 JSON 持久化 store —— 渲染进程持久化的权威副本（Electron 下）。
 *
 * 渲染端 localStorage 是同步读源（首次加载零闪烁）；此 store 作为「异步镜像」
 * 落盘到 userData/kart-settings.json，保证 localStorage 被清/超限时配置不丢。
 * 单文件 + 原子写（临时文件 + rename），崩溃不会留下半写文件。
 */
export class JsonStore {
  private _file: string
  private _data: Record<string, unknown> = {}
  /** 防抖计时器：高频保存合并为一次写盘 */
  private _flushTimer: ReturnType<typeof setTimeout> | null = null
  private _pending = false

  constructor() {
    this._file = path.join(app.getPath('userData'), 'kart-settings.json')
    this._load()
  }

  /** 渲染端调用：按 key 保存一个 JSON 值（fire-and-forget，防抖落盘） */
  save(key: string, value: unknown): void {
    this._data[key] = value
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this._flush()
    }, 500)
  }

  private _load(): void {
    try {
      if (fs.existsSync(this._file)) {
        const parsed = JSON.parse(fs.readFileSync(this._file, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this._data = parsed as Record<string, unknown>
        }
      }
    } catch (e) {
      mainLogger.warn('persist', `json store load failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private _flush(): void {
    if (this._pending) return
    this._pending = true
    try {
      const tmp = this._file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf-8')
      fs.renameSync(tmp, this._file)
    } catch (e) {
      mainLogger.error('persist', `json store write failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this._pending = false
    }
  }

  /** 退出前同步刷盘（will-quit 路径） */
  flushSync(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flush()
  }
}
