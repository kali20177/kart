import { ref, computed } from 'vue'
import type { IFileWriter } from './useFileWriter'
import { storage } from './useStorage'
import { persistNow } from '@/utils/persist'

/**
 * 管理录制保存目录的 composable（单例）。
 * 目录名存入 localStorage 用于跨刷新显示。
 * FileSystemDirectoryHandle 存 IndexedDB 用于跨刷新恢复（浏览器支持时），
 * 不支持时用户只需在设置中点击「选择目录」→ 浏览器自动定位到上次目录。
 */

const DIR_STORAGE_KEY = 'record-dir-name'
const DIR_PATH_KEY = 'record-dir-path'  // Electron only
// picker id 与 IndexedDB 名沿用存储前缀串，确保改名时一并更新、每次打开定位到上次目录。
// 注意：showDirectoryPicker 的 id 仅允许 ASCII 字母数字 / '-' / '_'，不能含 STORAGE_PREFIX 的冒号。
const PICKER_ID = 'kart-record'
const DB_NAME = 'kart-record'

// 单例状态
const dirName = ref<string | null>(storage.get<string | null>(DIR_STORAGE_KEY, null))
let dirHandle: FileSystemDirectoryHandle | null = null
const dirPath = ref<string | null>(storage.get<string | null>(DIR_PATH_KEY, null))

// ─── IndexedDB 句柄持久化（尽力而为，失败不阻塞） ───

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('handles')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function trySaveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction('handles', 'readwrite')
    tx.objectStore('handles').put(handle as unknown, 'record-dir')
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  } catch {
    // IDB 存储句柄失败不影响主要功能
  }
}

async function tryLoadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb()
    const tx = db.transaction('handles', 'readonly')
    const store = tx.objectStore('handles')
    return await new Promise((resolve, reject) => {
      const req = store.get('record-dir')
      req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  } catch {
    return null
  }
}

/**
 * 尝试为当前句柄申请读写权限（必须在用户手势中调用）。
 */
async function ensurePermission(): Promise<boolean> {
  if (!dirHandle) return false
  const perm = await dirHandle.queryPermission({ mode: 'readwrite' })
  if (perm === 'granted') return true
  try {
    const result = await dirHandle.requestPermission({ mode: 'readwrite' })
    return result === 'granted'
  } catch {
    return false
  }
}

// 从 localStorage 恢复了 dirName，再异步尝试从 IDB 恢复句柄
// resolve 时至少目录名已就绪，句柄可能有也可能没有
let restoreDone: Promise<void> = Promise.resolve()
restoreDone = tryLoadHandle().then((handle) => {
  if (handle) dirHandle = handle
}, () => {
  // IDB 加载失败不影响 localStorage 中的目录名展示
})

export function useRecordDirectory() {
  const isConfigured = computed(() => dirName.value !== null)
  // 展示用路径：Electron 有完整路径；浏览器 File System Access API 仅暴露目录名
  const displayPath = computed(() => dirPath.value ?? dirName.value)

  async function pick(): Promise<void> {
    // 等待 IDB 恢复完成
    await restoreDone

    // Electron 路径
    if (window.electron?.recorder?.showDirectoryPicker) {
      const result = await window.electron.recorder.showDirectoryPicker()
      if (result) {
        dirPath.value = result
        const parts = result.replace(/\\/g, '/').split('/')
        dirName.value = parts[parts.length - 1] || result
        persistNow(DIR_STORAGE_KEY, dirName.value)
        persistNow(DIR_PATH_KEY, dirPath.value)
      }
      return
    }

    // 浏览器路径：每次都重新弹出系统目录选择器。
    // id 参数让浏览器记住上次目录，重选时自动定位到那里；
    // 实际写入权限在 createFile 时按需 ensurePermission，不在此阻断重新选择。
    if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
      const picker = window.showDirectoryPicker!
      try {
        const handle = await picker({ id: PICKER_ID, mode: 'readwrite' } as { id: string; mode: 'readwrite' })
        dirHandle = handle as unknown as FileSystemDirectoryHandle
        dirName.value = handle.name
        persistNow(DIR_STORAGE_KEY, handle.name)
        // 异步存储句柄到 IDB（尽力）
        trySaveHandle(dirHandle)
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return
        throw e
      }
      return
    }

    throw new Error('当前环境不支持选择目录')
  }

  function clear() {
    dirHandle = null
    dirPath.value = null
    dirName.value = null
    storage.remove(DIR_STORAGE_KEY)
    storage.remove(DIR_PATH_KEY)
  }

  /**
   * 在录制目录中创建文件并返回写入器。
   * @param streamKey 录制流键（Electron 主进程按 (窗口, streamKey) 区分写入流，
   *   多会话并排录制时互不覆盖）。浏览器路径无流概念，忽略该参数。
   */
  async function createFile(fileName: string, streamKey?: string): Promise<IFileWriter | null> {
    // 等待 IDB 恢复完成
    await restoreDone

    // Electron 路径
    if (window.electron?.recorder?.createFile) {
      if (!dirPath.value) return null
      const result = await window.electron.recorder.createFile(dirPath.value, fileName, streamKey)
      if (!result) return null
      const rec = window.electron!.recorder!
      // 主进程可能因同名冲突改名（返回实际文件名），显示与闭包都用返回值
      const actualName = result.fileName
      return {
        // writeChunk 返回 false 表示流已出错 → 抛异常让 flushBuffer 走 error 分支
        write: async (chunk: Uint8Array): Promise<void> => {
          const ok = await rec.writeChunk(streamKey, chunk)
          if (!ok) throw new Error('主进程写入流失败')
        },
        close: async (): Promise<void> => {
          const ok = await rec.closeFile(streamKey)
          if (!ok) {
            // 流在最后一次写入和关闭之间出错（不影响已落盘数据），
            // 仅 trace 级别记录，不抛异常——调用方（stop）已经是收尾阶段。
            console.warn('[recorder] closeFile 报告流已出错，已落盘数据不受影响')
          }
        },
        getFileName: () => actualName
      }
    }

    // 浏览器路径
    if (dirHandle) {
      const ok = await ensurePermission()
      if (!ok) return null
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: true })
      const stream = await fileHandle.createWritable()
      return {
        write: (chunk: Uint8Array) => stream.write(chunk as never),
        close: () => stream.close(),
        getFileName: () => fileName
      }
    }

    return null
  }

  return { dirName, displayPath, isConfigured, pick, clear, createFile }
}
