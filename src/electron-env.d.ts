import type { ElectronSerial } from '@/serial/SerialPortDriver'

// preload 通过 contextBridge 暴露的 Electron 桥接 API（仅 Electron 下存在）。
// 从 env.d.ts 拆出独立模块文件，以便引用 SerialPortDriver 导出的 ElectronSerial
// 类型，为 window.electron.serial 提供精确类型，替代此前的 (window as any) 断言。
declare global {
  interface Window {
    electron?: {
      platform: string
      versions?: Record<string, string | undefined>
      toggleDevTools?: () => void
      serial?: ElectronSerial
      recorder?: {
        showDirectoryPicker(): Promise<string | null>
        createFile(dirPath: string, fileName: string): Promise<{ fileName: string } | null>
        writeChunk(chunk: Uint8Array): Promise<boolean>
        closeFile(): Promise<boolean>
        onWriteError(handler: (msg: string) => void): void
      }
    }
  }
}
