import { ref, computed } from 'vue'
import type { IFileWriter } from './useFileWriter'

/**
 * 管理录制保存目录的 composable（单例）。
 * 浏览器：通过 File System Access API（showDirectoryPicker）+ IndexedDB 持久化句柄。
 * Electron：通过 IPC 选择/存储路径。
 */

// 单例状态
const dirName = ref<string | null>(null)
let dirHandle: FileSystemDirectoryHandle | null = null
let dirPath: string | null = null

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

async function saveHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('handles', 'readwrite')
  tx.objectStore('handles').put(handle as unknown, key)
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function loadHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  const tx = db.transaction('handles', 'readonly')
  const store = tx.objectStore('handles')
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

async function restoreFromIdb(): Promise<boolean> {
  try {
    const handle = await loadHandle('record-dir')
    if (!handle) return false
    const perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') {
      dirHandle = handle
      dirName.value = handle.name
      return true
    }
    // 权限过期，尝试重新请求
    const reqPerm = await handle.requestPermission({ mode: 'readwrite' })
    if (reqPerm === 'granted') {
      dirHandle = handle
      dirName.value = handle.name
      return true
    }
    return false
  } catch {
    return false
  }
}

// 启动时尝试恢复
restoreFromIdb()

export function useRecordDirectory() {
  const isConfigured = computed(() => dirName.value !== null)

  async function pick(): Promise<void> {
    // Electron 路径
    if (window.electron?.recorder?.showDirectoryPicker) {
      const result = await window.electron.recorder.showDirectoryPicker()
      if (result) {
        dirPath = result
        const parts = result.replace(/\\/g, '/').split('/')
        dirName.value = parts[parts.length - 1] || result
      }
      return
    }

    // 浏览器路径
    if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
      const picker = window.showDirectoryPicker!
      try {
        const handle = await picker()
        dirHandle = handle as unknown as FileSystemDirectoryHandle
        dirName.value = handle.name
        await saveHandle('record-dir', handle as unknown as FileSystemDirectoryHandle)
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
  }

  async function createFile(fileName: string): Promise<IFileWriter | null> {
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
