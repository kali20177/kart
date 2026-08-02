import { storage, STORAGE_PREFIX } from '@/composables/useStorage'
import { estimateJsonSize } from './size'
import { logger } from './logger'

/**
 * 直写落盘 —— 用户数据（设置/命令/波特率/导出偏好/录制目录）变更即持久化，
 * 不依赖低频 deep watch 兜底。
 *
 * 三层：
 *  1. localStorage 同步写（保持首次加载同步读的语义，容量够时即最终存储）
 *  2. 异步镜像（浏览器 → IndexedDB `kart-persist`；Electron → 主进程 JSON 文件，
 *     经 window.electron.persist.save IPC）—— 容量满/被清时仍保底
 *  3. 容量自检：累计占用接近 localStorage 配额时全量快照导出 + 一次性提醒
 */

// ── 容量监控 ──

export const LOCALSTORAGE_LIMIT_BYTES = 5 * 1024 * 1024
export const WARN_THRESHOLD_BYTES = 1.5 * 1024 * 1024

/** 内存中的键占用估计（落盘时维护，避免每键 JSON 序列化两次） */
const trackedBytes = new Map<string, number>()

/** 本会话是否已导出过快照（限流，避免反复打扰） */
let snapshotExported = false

/** 快照导出事件——由 UI 层（MenuBar）订阅展示 toast */
export type SnapshotExportEvent = { keys: string[]; totalBytes: number }
type SnapshotExportListener = (e: SnapshotExportEvent) => void
const snapshotListeners = new Set<SnapshotExportListener>()

export function onSnapshotExport(l: SnapshotExportListener): () => void {
  snapshotListeners.add(l)
  return () => { snapshotListeners.delete(l) }
}

/** 需要进入快照的用户数据键（与 persistNow 调用点同源） */
const SNAPSHOT_KEYS = [
  'settings',
  'commands',
  'customBaudRates',
  'autoSave',
  'export-preferences',
  'record-dir-name',
  'record-dir-path',
] as const

function emitSnapshot(keys: string[]): void {
  const totalBytes = keys.reduce((sum, k) => sum + (trackedBytes.get(k) ?? 0), 0)
  for (const l of snapshotListeners) l({ keys, totalBytes })
}

// ── 镜像 ──

/** 浏览器 IndexedDB 镜像（与 useRecordDirectory 同模式，尽力而为） */
const IDB_NAME = 'kart-persist'
const IDB_STORE = 'values'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function mirrorToIdb(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, STORAGE_PREFIX + key)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* IDB 不可用（配额/隐私模式），镜像尽力而为 */ }
  finally { db.close() }
}

/** Electron 主进程文件镜像 */
async function mirrorToMain(key: string, value: unknown): Promise<void> {
  try {
    await window.electron?.persist?.save(key, value)
  } catch (e) {
    logger.warn('persist', `main-process mirror failed: ${key}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function mirror(key: string, value: unknown): Promise<void> {
  // IPC/IndexedDB 传输走 structured clone，Vue reactive proxy 无法被克隆，
  // 先解包为纯 JSON 再镜像，否则 Electron 镜像必失败（仅 localStorage 保底）
  let plain: unknown
  try {
    plain = JSON.parse(JSON.stringify(value))
  } catch {
    // 不可序列化数据（如含函数/循环引用）放弃镜像，不阻塞主流程
    return
  }
  const hasMain = !!window.electron?.persist?.save
  if (hasMain) return mirrorToMain(key, plain)
  return mirrorToIdb(key, plain)
}

// ── 导出 ──

/** 全量快照：收集全部用户数据键，导出为 JSON 文件 */
function buildSnapshot(): { keys: string[]; content: string; totalBytes: number } {
  const keys = [...SNAPSHOT_KEYS]
  const record: Record<string, unknown> = {}
  for (const k of keys) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + k)
      record[k] = raw == null ? null : JSON.parse(raw)
    } catch { record[k] = null }
  }
  return { keys, content: JSON.stringify(record, null, 2), totalBytes: 0 }
}

async function exportSnapshot(): Promise<void> {
  if (snapshotExported) return
  snapshotExported = true

  const { keys, content } = buildSnapshot()
  const fileName = `kart-settings-${Date.now()}.json`

  try {
    if (window.electron?.persist?.exportSnapshot) {
      const ok = await window.electron.persist.exportSnapshot(content, fileName)
      if (!ok) {
        logger.warn('persist', 'snapshot export cancelled by user')
        return
      }
    } else {
      const blob = new Blob([content], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    }
    emitSnapshot(keys)
    logger.info('persist', `snapshot exported: ${fileName} (${keys.length} keys)`)
  } catch (e) {
    logger.warn('persist', `snapshot export failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── 主入口 ──

/**
 * 持久化一个用户数据值。localStorage 同步写（读语义不变）+ 异步镜像 +
 * 容量自检。fire-and-forget：任何失败都不影响主流程。
 */
export function persistNow(key: string, value: unknown): void {
  storage.set(key, value)
  trackedBytes.set(key, estimateJsonSize(value))
  void mirror(key, value)

  const total = [...trackedBytes.values()].reduce((a, b) => a + b, 0)
  if (total >= WARN_THRESHOLD_BYTES) {
    logger.warn('persist', `storage usage ${total} bytes >= ${WARN_THRESHOLD_BYTES}, exporting snapshot`)
    void exportSnapshot()
  }
}
