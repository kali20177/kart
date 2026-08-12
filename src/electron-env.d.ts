import type { ElectronSerial } from '@/serial/SerialPortDriver'
import type { ElectronTcp } from '@/serial/TcpDriver'

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
      pty?: {
        open(id: string, options: { cols: number; rows: number }): Promise<void>
        write(id: string, data: string): Promise<void>
        resize(id: string, cols: number, rows: number): Promise<void>
        close(id: string): Promise<void>
        onData(handler: (data: string, id: string) => void): () => void
        onExit(handler: (id: string) => void): () => void
      }
      tcp?: ElectronTcp
      recorder?: {
        showDirectoryPicker(): Promise<string | null>
        createFile(dirPath: string, fileName: string, streamKey?: string): Promise<{ fileName: string } | null>
        writeChunk(streamKey: string | undefined, chunk: Uint8Array): Promise<boolean>
        closeFile(streamKey: string | undefined): Promise<boolean>
        onWriteError(handler: (msg: string) => void): void
      }
      log?: {
        /** 读取主进程全部日志文件内容（导出日志用） */
        read(): Promise<string[] | null>
      }
      persist?: {
        /** 按 key 保存一个 JSON 值到主进程镜像文件（kart-settings.json） */
        save(key: string, value: unknown): Promise<boolean>
        /** 全量快照导出（容量告警时），用户经系统对话框选择保存位置 */
        exportSnapshot(content: string, fileName: string): Promise<boolean>
      }
    }
    // Tauri 版原生桥（`window.kart`）在 Electron 分支不存在，声明为可选仅为让
    // QuickCommandsPanel 的 `window.kart?.saveTextFile` 通过类型检查；实际恒为
    // undefined，导出走 Blob 回退（Electron 为 Chromium，三平台行为一致）。
    kart?: {
      saveTextFile(
        content: string,
        fileName: string,
        filters?: { name: string; extensions: string[] }[]
      ): Promise<boolean>
    }
  }
}
