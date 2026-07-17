import { contextBridge, ipcRenderer } from 'electron'

// 主进程回调写盘错误时，转发给渲染进程录制器（按窗口）。可选监听。
let writeErrorHandler: ((msg: string) => void) | null = null
ipcRenderer.on('recorder:write-error', (_e, msg: string) => {
  writeErrorHandler?.(msg)
})

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions,
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  recorder: {
    showDirectoryPicker: () =>
      ipcRenderer.invoke('recorder:show-directory-picker'),
    createFile: (dirPath: string, fileName: string) =>
      ipcRenderer.invoke('recorder:create-file', dirPath, fileName),
    // invoke 返回 false 表示流已出错/无活动流，触发渲染进程置 error 状态
    writeChunk: (chunk: Uint8Array) =>
      ipcRenderer.invoke('recorder:write-chunk', chunk) as Promise<boolean>,
    closeFile: () =>
      ipcRenderer.invoke('recorder:close-file') as Promise<boolean>,
    onWriteError: (handler: (msg: string) => void) => {
      writeErrorHandler = handler
    }
  }
})