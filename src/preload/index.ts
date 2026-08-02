import { contextBridge, ipcRenderer } from 'electron'

// 主进程回调写盘错误时，转发给渲染进程录制器（按窗口）。可选监听。
let writeErrorHandler: ((msg: string) => void) | null = null
ipcRenderer.on('recorder:write-error', (_e, msg: string) => {
  writeErrorHandler?.(msg)
})

// ── serialport 数据事件 ──
// 主进程通过 webContents.send('serial:data', { path, data }) 推送，
// 此处按 Set 转发给各驱动实例的 handler（多实例互不覆盖）。
type SerialDataHandler = (data: Uint8Array, path: string) => void
type SerialErrorHandler = (msg: string, path: string) => void
const serialDataHandlers = new Set<SerialDataHandler>()
const serialErrorHandlers = new Set<SerialErrorHandler>()
ipcRenderer.on('serial:data', (_e, payload: { path: string; data: Uint8Array }) => {
  for (const h of serialDataHandlers) h(payload.data, payload.path)
})
ipcRenderer.on('serial:error', (_e, payload: { path: string; msg: string }) => {
  for (const h of serialErrorHandlers) h(payload.msg, payload.path)
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
    close: (portName: string) => ipcRenderer.invoke('serial:close', portName),

    /** 写入数据，返回实际写入字节数 */
    write: (portName: string, data: Uint8Array) =>
      ipcRenderer.invoke('serial:write', portName, data) as Promise<number>,

    /** 获取信号状态 */
    getSignals: (portName: string) => ipcRenderer.invoke('serial:get-signals', portName) as Promise<{
      dcd: boolean
      cts: boolean
      dsr: boolean
      ri: boolean
    }>,

    /** 注册数据接收回调，返回取消订阅函数 */
    onData: (handler: SerialDataHandler) => {
      serialDataHandlers.add(handler)
      return () => { serialDataHandlers.delete(handler) }
    },

    /** 注册错误/断连回调，返回取消订阅函数 */
    onError: (handler: SerialErrorHandler) => {
      serialErrorHandlers.add(handler)
      return () => { serialErrorHandlers.delete(handler) }
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
  },

  // 持久化镜像：渲染端 localStorage 的权威副本（kart-settings.json）。
  // 渲染端 persistNow 每次调用触发 save；容量告警时经 exportSnapshot 走系统对话框保存。
  persist: {
    save: (key: string, value: unknown) =>
      ipcRenderer.invoke('persist:save', key, value) as Promise<boolean>,
    exportSnapshot: (content: string, fileName: string) =>
      ipcRenderer.invoke('persist:export-snapshot', content, fileName) as Promise<boolean>,
  }
})