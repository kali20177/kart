/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-virtual-scroller'

declare const __APP_VERSION__: string
declare const __GIT_COMMIT__: string
declare const __BUILD_DATE__: string
declare const __DEP_VERSIONS__: Record<string, string>

// File System Access API 类型声明（TS lib 尚未覆盖新版 API）
interface FileSystemWritableFileStream {
  write(data: Uint8Array | ArrayBuffer): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle {
  name: string
  kind: 'directory'
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  queryPermission(descriptor: { mode: FileSystemPermissionMode }): Promise<FileSystemPermissionStatus>
  requestPermission(descriptor: { mode: FileSystemPermissionMode }): Promise<FileSystemPermissionStatus>
}

// preload 通过 contextBridge 暴露（仅 Electron 下存在）
interface Window {
  electron?: {
    platform: string
    versions?: Record<string, string | undefined>
    toggleDevTools?: () => void
    recorder?: {
      showDirectoryPicker(): Promise<string | null>
      createFile(dirPath: string, fileName: string): Promise<{ fileName: string } | null>
      writeChunk(chunk: Uint8Array): Promise<void>
      closeFile(): Promise<void>
    }
  }
  showSaveFilePicker?(options?: {
    suggestedName?: string
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }): Promise<FileSystemFileHandle & { name: string }>
  showDirectoryPicker?(options?: { id?: string }): Promise<FileSystemDirectoryHandle>
}
