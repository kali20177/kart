import { contextBridge, ipcRenderer } from 'electron'
import type { UpdaterState } from '@/utils/updater'

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

// ── 本地 pty 终端数据事件 ──
// 主进程通过 webContents.send('pty:data'/'pty:exit') 推送本地 shell 输出与退出。
type PtyDataHandler = (data: string, id: string) => void
type PtyExitHandler = (id: string) => void
const ptyDataHandlers = new Set<PtyDataHandler>()
const ptyExitHandlers = new Set<PtyExitHandler>()
ipcRenderer.on('pty:data', (_e, payload: { id: string; data: string }) => {
  for (const h of ptyDataHandlers) h(payload.data, payload.id)
})
ipcRenderer.on('pty:exit', (_e, payload: { id: string; exitCode: number; signal?: number }) => {
  for (const h of ptyExitHandlers) h(payload.id)
})

// ── TCP 连接数据事件 ──
// 主进程通过 webContents.send('tcp:data'/'tcp:error', { id, ... }) 推送（id=主进程分配的 connId），
// 形态与 serial 完全一致（Uint8Array 字节 + Set 转发），仅事件名与路由字段名不同。
// 同一端点可开多个连接：每个连接有独立 connId，渲染端各驱动实例按自己的 connId 过滤。
type TcpDataHandler = (data: Uint8Array, id: string) => void
type TcpErrorHandler = (msg: string, id: string) => void
const tcpDataHandlers = new Set<TcpDataHandler>()
const tcpErrorHandlers = new Set<TcpErrorHandler>()
ipcRenderer.on('tcp:data', (_e, payload: { id: string; data: Uint8Array }) => {
  for (const h of tcpDataHandlers) h(payload.data, payload.id)
})
ipcRenderer.on('tcp:error', (_e, payload: { id: string; msg: string }) => {
  for (const h of tcpErrorHandlers) h(payload.msg, payload.id)
})

// ── 应用自升级 ──
// 主进程经 webContents.send('updater:event', state) 推送完整状态快照
// （单一通道 + 完整快照：订阅方无需按事件类型拼装，防渲染端竞态）。
type UpdaterStateHandler = (state: UpdaterState) => void
const updaterStateHandlers = new Set<UpdaterStateHandler>()
ipcRenderer.on('updater:event', (_e, state: UpdaterState) => {
  for (const h of updaterStateHandlers) h(state)
})

// ── 入站 MCP 服务器 ──
// 主进程经 webContents.send('mcp:tool-call', {callId, tool, args}) 请求渲染端
// 工具注册表执行，执行完毕经 mcp:tool-result invoke 应答（callId 关联）。
type McpToolCallHandler = (payload: { callId: number; tool: string; args: unknown }) => void
const mcpToolCallHandlers = new Set<McpToolCallHandler>()
ipcRenderer.on('mcp:tool-call', (_e, payload: { callId: number; tool: string; args: unknown }) => {
  for (const h of mcpToolCallHandlers) h(payload)
})

// ── 应用菜单（macOS 原生菜单）──
// 主进程菜单项 click 经 webContents.send('menu:action', action) 下发动作 key，
// 渲染层 MenuBar 统一分发（与自绘菜单同路径）；渲染端经 menu:update-state
// 推送勾选态/录制状态/语言，驱动主进程重建菜单。
type MenuActionHandler = (action: string) => void
const menuActionHandlers = new Set<MenuActionHandler>()
ipcRenderer.on('menu:action', (_e, action: string) => {
  for (const h of menuActionHandlers) h(action)
})

/** MCP 状态快照（主进程 get-state/start/stop 返回；与渲染端 McpBridgeState 对齐）。 */
type McpApiState = { running: boolean; port: number | null; token: string | null; mode: string }

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions,
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // ── serialport 原生串口驱动（主进程 native 串口库）──
  serial: {
    /** 枚举可用串口，返回 { path, manufacturer?, vendorId?, productId?, busy? }[] */
    listPorts: () =>
      ipcRenderer.invoke('serial:list-ports') as Promise<Array<{
        path: string
        manufacturer?: string
        vendorId?: string
        productId?: string
        busy?: boolean
      }>>,

    /** 打开串口 */
    open: (portName: string, options: {
      baudRate: number
      dataBits: 5 | 6 | 7 | 8
      stopBits: 1 | 1.5 | 2
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

    /** 设置输出控制线（DTR/RTS）。未提供的项保持不变 */
    setSignals: (portName: string, signals: { dtr?: boolean; rts?: boolean }) =>
      ipcRenderer.invoke('serial:set-signals', portName, signals) as Promise<void>,

    /** 置/清 Break 条件（TX 拉低） */
    setBreak: (portName: string, active: boolean) =>
      ipcRenderer.invoke('serial:set-break', portName, active) as Promise<void>,

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

  // ── 本地 pty 终端（node-pty，本地 shell 验证）──
  pty: {
    /** 启动本地 shell，返回固定 id（渲染端用 'local-shell' 连接） */
    open: (id: string, options: { cols: number; rows: number }) =>
      ipcRenderer.invoke('pty:open', id, options),

    /** 写入 pty（用户按键 / 行发送） */
    write: (id: string, data: string) =>
      ipcRenderer.invoke('pty:write', id, data),

    /** 同步窗口尺寸到 pty（vim 全屏必需） */
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),

    /** 关闭本地 shell */
    close: (id: string) =>
      ipcRenderer.invoke('pty:close', id),

    /** 注册 pty 输出回调，返回取消订阅函数 */
    onData: (handler: PtyDataHandler) => {
      ptyDataHandlers.add(handler)
      return () => { ptyDataHandlers.delete(handler) }
    },

    /** 注册 pty 退出回调（shell 进程结束），返回取消订阅函数 */
    onExit: (handler: PtyExitHandler) => {
      ptyExitHandlers.add(handler)
      return () => { ptyExitHandlers.delete(handler) }
    }
  },

  // ── TCP client（主进程 net 模块，仅 Electron）──
  // 端点统一为 "host:port" 字符串；open 返回主进程分配的 connId，后续读写/事件按 connId 路由。
  tcp: {
    /** 连接远端（host:port），返回主进程分配的连接 id（connId） */
    open: (endpoint: string) =>
      ipcRenderer.invoke('tcp:open', endpoint) as Promise<string>,

    /** 关闭指定连接（connId） */
    close: (connId: string) =>
      ipcRenderer.invoke('tcp:close', connId),

    /** 写入字节到指定连接（connId） */
    write: (connId: string, data: Uint8Array) =>
      ipcRenderer.invoke('tcp:write', connId, data),

    /** 注册数据接收回调，返回取消订阅函数 */
    onData: (handler: TcpDataHandler) => {
      tcpDataHandlers.add(handler)
      return () => { tcpDataHandlers.delete(handler) }
    },

    /** 注册错误/断连回调，返回取消订阅函数 */
    onError: (handler: TcpErrorHandler) => {
      tcpErrorHandlers.add(handler)
      return () => { tcpErrorHandlers.delete(handler) }
    }
  },

  recorder: {
    showDirectoryPicker: () =>
      ipcRenderer.invoke('recorder:show-directory-picker'),
    // streamKey：录制流标识（如端口名），主进程按 (窗口, streamKey) 键控写入流
    createFile: (dirPath: string, fileName: string, streamKey?: string) =>
      ipcRenderer.invoke('recorder:create-file', dirPath, fileName, streamKey),
    // invoke 返回 false 表示流已出错/无活动流，触发渲染进程置 error 状态
    writeChunk: (streamKey: string | undefined, chunk: Uint8Array) =>
      ipcRenderer.invoke('recorder:write-chunk', streamKey, chunk) as Promise<boolean>,
    closeFile: (streamKey: string | undefined) =>
      ipcRenderer.invoke('recorder:close-file', streamKey) as Promise<boolean>,
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
  },

  // ── 应用自升级（渲染端契约与后端无关，见 docs/upgrade-design.md §15）──
  updater: {
    /** 当前状态快照（挂载时同步用，防事件早于订阅丢失） */
    getState: () => ipcRenderer.invoke('updater:get-state') as Promise<UpdaterState>,
    /** 检查更新（进行中/下载中守卫，幂等） */
    check: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterState>,
    /** 开始下载（仅 available 状态生效） */
    download: () => ipcRenderer.invoke('updater:download') as Promise<UpdaterState>,
    /** 取消进行中的下载（状态回到 available，可重新下载） */
    cancelDownload: () => ipcRenderer.invoke('updater:cancel-download') as Promise<void>,
    /** 退出并安装（调用方须先确认录制/下发风险） */
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install') as Promise<void>,
    /** 打开 GitHub Releases 页（手动下载兜底） */
    openReleases: () => ipcRenderer.invoke('updater:open-releases') as Promise<void>,
    /** 订阅状态推送，返回退订函数 */
    onState: (handler: UpdaterStateHandler) => {
      updaterStateHandlers.add(handler)
      return () => { updaterStateHandlers.delete(handler) }
    }
  },

  // ── 应用菜单（macOS 原生菜单；其他平台 window.electron.menu 存在但主进程不消费）──
  menu: {
    /** 订阅原生菜单动作（key 与自绘菜单一致），返回退订函数 */
    onAction: (handler: MenuActionHandler) => {
      menuActionHandlers.add(handler)
      return () => { menuActionHandlers.delete(handler) }
    },
    /** 推送菜单驱动状态（locale/autoSave/录制/侧栏），主进程据此重建菜单 */
    updateState: (state: {
      locale: string
      autoSave: boolean
      quickRailVisible: boolean
      recording: string
      recordingSupported: boolean
    }) => ipcRenderer.send('menu:update-state', state),
  },

  // ── 入站 MCP 服务器（docs/mcp-design.md；主进程 McpServer）──
  mcp: {
    /** 当前服务器状态快照（running/port/token/mode） */
    getState: () => ipcRenderer.invoke('mcp:get-state') as Promise<McpApiState>,
    /** 启动（幂等；token 空则主进程随机生成）。返回最新状态 */
    start: (config: { port: number; token: string | null; mode: string }) =>
      ipcRenderer.invoke('mcp:start', config) as Promise<McpApiState>,
    /** 停止（幂等）。返回最新状态 */
    stop: () => ipcRenderer.invoke('mcp:stop') as Promise<McpApiState>,
    /** 工具执行完毕应答（渲染端注册表 → 主进程挂起的 MCP 调用） */
    toolResult: (callId: number, ok: boolean, result: unknown) =>
      ipcRenderer.invoke('mcp:tool-result', { callId, ok, result }) as Promise<boolean>,
    /** 订阅主进程发来的工具调用请求（callId 关联应答），返回退订函数 */
    onToolCall: (handler: McpToolCallHandler) => {
      mcpToolCallHandlers.add(handler)
      return () => { mcpToolCallHandlers.delete(handler) }
    }
  }
})
