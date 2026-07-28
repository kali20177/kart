import { contextBridge, ipcRenderer } from 'electron'

// 主进程回调写盘错误时，转发给渲染进程录制器（按窗口）。可选监听。
let writeErrorHandler: ((msg: string) => void) | null = null
ipcRenderer.on('recorder:write-error', (_e, msg: string) => {
  writeErrorHandler?.(msg)
})

// ── serialport 数据事件 ──
// 主进程通过 webContents.send('serial:data', Uint8Array) 推送，此处转发给渲染进程
let serialDataHandler: ((data: Uint8Array) => void) | null = null
ipcRenderer.on('serial:data', (_e, data: Uint8Array) => {
  serialDataHandler?.(data)
})
let serialErrorHandler: ((msg: string) => void) | null = null
ipcRenderer.on('serial:error', (_e, msg: string) => {
  serialErrorHandler?.(msg)
})

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions,
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // ── serialport 原生串口驱动（主进程 native 串口库）──
  serial: {
    /** 枚举可用串口，返回 { path, manufacturer?, vendorId?, productId? }[] */
    listPorts: () =>
      ipcRenderer.invoke('serial:list-ports') as Promise<Array<{
        path: string
        manufacturer?: string
        vendorId?: string
        productId?: string
      }>>,

    /** 打开串口 */
    open: (portName: string, options: {
      baudRate: number
      dataBits: 7 | 8
      stopBits: 1 | 2
      parity: 'none' | 'even' | 'odd'
      flowControl: 'none' | 'hardware'
    }) => ipcRenderer.invoke('serial:open', portName, options),

    /** 关闭串口 */
    close: () => ipcRenderer.invoke('serial:close'),

    /** 写入数据，返回实际写入字节数 */
    write: (data: Uint8Array) =>
      ipcRenderer.invoke('serial:write', data) as Promise<number>,

    /** 获取信号状态 */
    getSignals: () => ipcRenderer.invoke('serial:get-signals') as Promise<{
      dcd: boolean
      cts: boolean
      dsr: boolean
      ri: boolean
    }>,

    /** 串口是否已打开 */
    isOpen: () => ipcRenderer.invoke('serial:is-open') as Promise<boolean>,

    /** 注册数据接收回调 */
    onData: (handler: (data: Uint8Array) => void) => {
      serialDataHandler = handler
    },

    /** 注册错误/断连回调 */
    onError: (handler: (msg: string) => void) => {
      serialErrorHandler = handler
    },

    /** 移除数据/错误回调 */
    removeListeners: () => {
      serialDataHandler = null
      serialErrorHandler = null
    }
  },

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
  },

  // 日志：渲染端「导出日志」的数据来源。无需 write 通道——
  // 渲染端任何 console 输出都会经主进程 console-message 事件落到同一批日志文件。
  log: {
    read: () => ipcRenderer.invoke('log:read') as Promise<string[] | null>,
  }
})