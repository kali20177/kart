import type { RecordFormat } from '@/types'

/** 平台无关的文件写入句柄 */
export interface IFileWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  getFileName(): string
}

/**
 * 检测平台并返回创建 IFileWriter 的工厂函数。
 * 返回 null 表示平台不支持（非安全上下文或旧版浏览器）。
 */
export function createFileWriter(): {
  open(suggestedName: string, _format: RecordFormat): Promise<IFileWriter | null>
} | null {
  // Electron 路径
  if (window.electron?.recorder) {
    return {
      open: async (suggestedName, _format) => {
        const result = await window.electron!.recorder!.openSaveDialog(suggestedName)
        if (!result) return null
        return new ElectronFileWriter(result.filePath, result.fileName)
      }
    }
  }

  // 浏览器路径：需要 File System Access API（安全上下文 + Chromium）
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    const showSaveFilePicker = window.showSaveFilePicker!
    return {
      open: async (suggestedName, format) => {
        try {
          const extMap: Record<string, string> = { text: '.txt', csv: '.csv' }
          const descMap: Record<string, string> = { text: 'Text Log', csv: 'CSV Log' }
          const ext = extMap[format] || '.txt'
          const mime = 'text/plain'
          const desc = descMap[format] || 'Log'
          const handle = await showSaveFilePicker({
            suggestedName,
            types: [{
              description: desc,
              accept: { [mime]: [ext] }
            }]
          })
          const stream = await handle.createWritable()
          return {
            write: (chunk: Uint8Array) => stream.write(chunk),
            close: () => stream.close(),
            getFileName: () => handle.name
          }
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') return null
          throw e
        }
      }
    }
  }

  return null
}

class ElectronFileWriter implements IFileWriter {
  private closed = false

  constructor(
    _filePath: string,
    private fileName: string
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) return
    await window.electron!.recorder!.writeChunk(chunk)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await window.electron!.recorder!.closeFile()
  }

  getFileName(): string {
    return this.fileName
  }
}
