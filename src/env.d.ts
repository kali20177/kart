/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-virtual-scroller'

// 构建期由 vite define 注入（见 vite.config.ts）
declare const __APP_VERSION__: string
declare const __GIT_COMMIT__: string
declare const __BUILD_DATE__: string
declare const __DEP_VERSIONS__: Record<string, string>

// preload 通过 contextBridge 暴露（仅 Electron 下存在）
interface Window {
  electron?: {
    platform: string
    versions?: Record<string, string | undefined>
    toggleDevTools?: () => void
    recorder?: {
      openSaveDialog(suggestedName: string): Promise<{ filePath: string; fileName: string } | null>
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
  }): Promise<{
    createWritable(): Promise<{
      write(chunk: Uint8Array): Promise<void>
      close(): Promise<void>
    }>
    name: string
  }>
}
