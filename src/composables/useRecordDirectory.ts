import { ref, computed } from 'vue'
import type { IFileWriter } from './useFileWriter'
import { storage } from './useStorage'

/**
 * 管理录制保存目录的 composable（单例）。
 * 目录名存入 localStorage 用于跨刷新显示。
 * FileSystemDirectoryHandle 存 IndexedDB 用于跨刷新恢复（浏览器支持时），
 * 不支持时用户只需在设置中点击「选择目录」→ 浏览器自动定位到上次目录。
 */

const DIR_STORAGE_KEY = 'record-dir-name'
const DIR_PATH_KEY = 'record-dir-path'  // Electron only
const PICKER_ID = 'serial-demo-record'

// 单例状态
const dirName = ref<string | null>(storage.get<string | null>(DIR_STORAGE_KEY, null))
let dirHandle: FileSystemDirectoryHandle | null = null
let dirPath: string | null = storage.get<string | null>(DIR_PATH_KEY, null)

// ─── IndexedDB 句柄持久化（尽力而为，失败不阻塞） ───

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('serial-demo', 1)
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

  async function pick(): Promise<void> {
    // 等待 IDB 恢复完成
    await restoreDone

    // Electron 路径
    if (window.electron?.recorder?.showDirectoryPicker) {
      const result = await window.electron.recorder.showDirectoryPicker()
      if (result) {
        dirPath = result
        const parts = result.replace(/\\/g, '/').split('/')
        dirName.value = parts[parts.length - 1] || result
        storage.set(DIR_STORAGE_KEY, dirName.value)
        storage.set(DIR_PATH_KEY, dirPath)
      }
      return
    }

    // 浏览器路径：已有句柄但权限过期→先尝试重新授权
    if (dirHandle) {
      const ok = await ensurePermission()
      if (ok) {
        dirName.value = dirHandle.name
        storage.set(DIR_STORAGE_KEY, dirName.value)
        return
      }
    }

    // 无句柄或权限被拒→弹出系统目录选择器
    // 使用 id 参数让浏览器记住上次目录，重选时自动定位
    if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
      const picker = window.showDirectoryPicker!
      try {
        const handle = await picker({ id: PICKER_ID })
        dirHandle = handle as unknown as FileSystemDirectoryHandle
        dirName.value = handle.name
        storage.set(DIR_STORAGE_KEY, handle.name)
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
    dirPath = null
    dirName.value = null
    storage.remove(DIR_STORAGE_KEY)
    storage.remove(DIR_PATH_KEY)
  }

  async function createFile(fileName: string): Promise<IFileWriter | null> {
    // 等待 IDB 恢复完成
    await restoreDone

    // Electron 路径
    if (window.electron?.recorder?.createFile) {
      if (!dirPath) return null
      const result = await window.electron.recorder.createFile(dirPath, fileName)
      if (!result) return null
      return {
        write: (chunk: Uint8Array) => window.electron!.recorder!.writeChunk(chunk),
        close: () => window.electron!.recorder!.closeFile(),
        getFileName: () => fileName
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

  return { dirName, isConfigured, pick, clear, createFile }
}
