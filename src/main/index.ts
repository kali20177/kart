import { app, BrowserWindow, Menu, ipcMain, dialog, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { SerialPortManager } from './SerialPortManager'
import { TcpManager } from './TcpManager'
import { PtyManager } from './PtyManager'
import { JsonStore } from './JsonStore'
import { Updater } from './Updater'
import { mainLogger } from './logger'

// ── 全局错误拦截（必须在最前面注册） ──
// errorSync 用同步写盘 + stderr 双通道：此时日志可能尚未 init（logDir 为空会回落 stderr），
// 且进程即将退出，异步 WriteStream 来不及刷盘。
process.on('uncaughtException', (err) => {
  mainLogger.errorSync('main', `Uncaught exception: ${err.name}: ${err.message}\n${err.stack ?? ''}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
    : String(reason)
  mainLogger.error('main', `Unhandled rejection: ${msg}`)
})

const devServerUrl = process.env.VITE_DEV_SERVER_URL

// 每个录制流的活动写入流及其最近一次写盘错误（录制器用）。
// 键为 `${winId}:${streamKey}`：多会话并排录制时（同窗口多端口 / 多窗口），
// 每个会话的流独立管理，互不覆盖——单窗口旧实现按 win.id 键控，后起的会话
// 会顶掉先起会话的流，导致数据写进对方的文件。
interface ActiveStream {
  stream: fs.WriteStream
  lastError: string | null
}
const writeStreams = new Map<string, ActiveStream>()
const streamKeyOf = (winId: number, key?: string) => `${winId}:${key ?? ''}`

function registerRecorderIpc(): void {
  // 目录选择器（替换原来的文件保存对话框）
  ipcMain.handle('recorder:show-directory-picker', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })

    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // 在指定目录中创建文件并打开写入流。
  // 默认 flags:'w'（截断）——文件名含端口 + 秒级时间戳，正常无同名；
  // 同秒重启录制等极端情况经存在性检测追加 `-2`/`-3` 后缀避免截断旧文件。
  // streamKey 由渲染端传入（如端口名），同一会话重启录制时替换旧流而非新建键。
  ipcMain.handle('recorder:create-file', async (event, dirPath: string, fileName: string, streamKey?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    // 同名冲突（同秒同端口重启录制）：追加序号后缀，返回实际文件名供渲染端展示
    let fullPath = path.join(dirPath, fileName)
    let actualName = fileName
    const ext = path.extname(fileName)
    const base = path.basename(fileName, ext)
    for (let n = 2; fs.existsSync(fullPath); n++) {
      actualName = `${base}-${n}${ext}`
      fullPath = path.join(dirPath, actualName)
    }

    const stream = fs.createWriteStream(fullPath, { flags: 'w' })
    const entry: ActiveStream = { stream, lastError: null }
    const key = streamKeyOf(win.id, streamKey)

    // 流级错误（ENOSPC/EPERM 等）单向 send 无法上报到渲染进程，
    // 这里监听 error 并记录，由 write-chunk/close 时经 sender 通道回传。
    stream.on('error', (err: NodeJS.ErrnoException) => {
      entry.lastError = err?.message ?? String(err)
      try {
        event.sender.send('recorder:write-error', entry.lastError)
      } catch {
        // 窗口可能已销毁，忽略
      }
    })

    // 替换旧流（若有）：同一 (窗口, streamKey) 重启录制时先正常关闭旧的，避免句柄泄漏
    const prev = writeStreams.get(key)
    if (prev) {
      try { prev.stream.end() } catch { /* ignore */ }
    }
    writeStreams.set(key, entry)

    return { fileName: actualName }
  })

  // 将块写入已打开的文件。返回 true 表示已提交到流（不代表已 fsync），
  // false 表示无打开流或流已出错——渲染进程据此把录制状态置为 error。
  ipcMain.handle('recorder:write-chunk', async (event, streamKey: string | undefined, chunk: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const entry = writeStreams.get(streamKeyOf(win.id, streamKey))
    if (!entry) return false
    if (entry.lastError) return false

    return await new Promise<boolean>((resolve) => {
      const ok = entry.stream.write(Buffer.from(chunk), (err) => {
        // 写回调查询错误
        if (err && !entry.lastError) {
          entry.lastError = err.message ?? String(err)
          try {
            event.sender.send('recorder:write-error', entry.lastError)
          } catch { /* ignore */ }
        }
      })
      resolve(ok && !entry.lastError)
    })
  })

  // 刷新并关闭文件流。返回 true=正常关闭，false=流已出错。
  ipcMain.handle('recorder:close-file', async (event, streamKey: string | undefined) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return true
    const key = streamKeyOf(win.id, streamKey)
    const entry = writeStreams.get(key)
    if (!entry) return true
    writeStreams.delete(key)

    const hadError = entry.lastError !== null
    await new Promise<void>((resolve) => {
      entry.stream.end(() => resolve())
      // 兜底：end 回调未在合理时间内触发也放行
      setTimeout(resolve, 1000)
    })
    return !hadError
  })
}

/**
 * Web Serial API 在 Electron 渲染进程可用，但需主进程配合两件事，否则
 * navigator.serial.requestPort()/getPorts() 会被拒（点「选择端口」无反应）：
 *   1. setPermissionCheckHandler 放行 'serial' 权限检查（getPorts 复用已授权端口、
 *      requestPort 选择后访问均触发）；
 *   2. 响应 'select-serial-port' 事件--Electron 不自带浏览器那样的原生串口
 *      选择器，必须自行实现并经 callback(portId) 回传；传空串表示取消。
 * portList 来自 Electron 的跨平台串口枚举（win/linux/macos），故此实现三平台通用。
 * 注：Linux 用户需在 dialout 组、macOS 需设备未被系统占用，属 OS 层前提，非代码可解。
 */
function configureWebSerial(): void {
  const ses = session.defaultSession

  // 放行 'serial' 权限检查（getPorts 复用已授权端口、requestPort 选择后访问均触发）。
  // 串口的「请求」由下方 select-serial-port 事件接管，不经过 setPermissionRequestHandler。
  // 'local-fonts'：渲染端 queryLocalFonts 枚举系统字体（设置→终端→字体），无 handler 时该权限默认拒绝。
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || (permission as string) === 'local-fonts')
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback((permission as string) === 'local-fonts'))

  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault()
    const win = BrowserWindow.fromWebContents(webContents)

    if (portList.length === 0) {
      void (win
        ? dialog.showMessageBox(win, {
            type: 'warning',
            title: '未发现串口',
            message: '未检测到可用的串口设备',
            detail: '请确认设备已连接、驱动已安装且未被其他程序占用。',
            buttons: ['确定']
          })
        : dialog.showMessageBox({
            type: 'warning',
            title: '未发现串口',
            message: '未检测到可用的串口设备',
            buttons: ['确定']
          })
      )
      callback('')
      return
    }

    // 端口列表作为按钮，末尾追加「取消」。label 优先用 portName（可读）。
    const labels = portList.map((p) => p.portName || p.portId)
    const buttons = [...labels, '取消']
    const cancelId = buttons.length - 1
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '选择串口设备',
      message: '选择要连接的串口设备',
      buttons,
      defaultId: 0,
      cancelId,
      noLink: true
    }
    void (win
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options)
    ).then((result) => {
      if (result.response === cancelId) callback('')
      else callback(portList[result.response].portId)
    })
  })
}

// ── serialport 原生串口驱动 ──

// 每个窗口对应一个管理器（用于把数据事件推回本窗口渲染进程）
const _serialManagers = new Map<number, SerialPortManager>()

// ── 本地 pty 终端（node-pty，验证本地 shell / vim 全屏）──

// 每个窗口对应一个管理器（用于把 pty 输出推回本窗口渲染进程）
const _ptyManagers = new Map<number, PtyManager>()

// ── TCP client（net 模块，每个窗口一个管理器，按端点管理多个连接）──
const _tcpManagers = new Map<number, TcpManager>()

/** 注册本地 pty 终端 IPC handlers */
function registerPtyIpc(): void {
  // 启动一个本地 shell（渲染端以固定 id 连接）
  ipcMain.handle('pty:open', (event, id: string, options: { cols: number; rows: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _ptyManagers.get(win.id) : null
    if (!mgr) throw new Error('pty 管理器不可用')
    try {
      mgr.open(id, options)
      mainLogger.info('pty', `pty opened: ${id}`)
    } catch (e) {
      mainLogger.error('pty', `open failed: ${id}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })

  // 写入 pty（用户按键 / line 模式发送）
  ipcMain.handle('pty:write', (event, id: string, data: string) => {
    _ptyManagers.get(BrowserWindow.fromWebContents(event.sender)?.id ?? -1)?.write(id, data)
  })

  // 同步窗口尺寸到 pty（shell 的 stty 感知，vim 全屏必需）
  ipcMain.handle('pty:resize', (event, id: string, cols: number, rows: number) => {
    _ptyManagers.get(BrowserWindow.fromWebContents(event.sender)?.id ?? -1)?.resize(id, cols, rows)
  })

  // 关闭 pty
  ipcMain.handle('pty:close', (event, id: string) => {
    _ptyManagers.get(BrowserWindow.fromWebContents(event.sender)?.id ?? -1)?.close(id)
  })
}

/** 注册 TCP client 相关 IPC handlers（endpoint = "host:port"，连接以 connId 路由） */
function registerTcpIpc(): void {
  // 连接远端，返回主进程分配的 connId
  ipcMain.handle('tcp:open', async (event, endpoint: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _tcpManagers.get(win.id) : null
    if (!mgr) throw new Error('TCP 管理器不可用')
    try {
      const connId = await mgr.open(endpoint)
      mainLogger.info('tcp', `connected: ${endpoint} (${connId})`)
      return connId
    } catch (e) {
      mainLogger.error('tcp', `connect failed: ${endpoint}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })

  // 关闭指定连接（connId）
  ipcMain.handle('tcp:close', (event, connId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _tcpManagers.get(win.id) : null
    mgr?.close(connId)
  })

  // 写入数据到指定连接（connId）
  ipcMain.handle('tcp:write', async (event, connId: string, data: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _tcpManagers.get(win.id) : null
    if (!mgr) throw new Error('TCP 管理器不可用')
    await mgr.write(connId, Buffer.from(data))
  })
}

/** 注册 serialport 相关的 IPC handlers */
function registerSerialPortIpc(): void {
  // 枚举可用串口，返回真实 COM 口名
  ipcMain.handle('serial:list-ports', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    if (!mgr) return []
    return await mgr.listPortsAsync()
  })

  // 打开串口
  ipcMain.handle('serial:open', async (event, portName: string, options: {
    baudRate: number
    dataBits: 5 | 6 | 7 | 8
    stopBits: 1 | 1.5 | 2
    parity: 'none' | 'even' | 'odd'
    flowControl: 'none' | 'hardware'
  }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('窗口不存在')
    const mgr = _serialManagers.get(win.id)
    if (!mgr) throw new Error('串口管理器不可用')
    try {
      await mgr.open(portName, options)
      const p = options.parity === 'none' ? 'N' : options.parity === 'even' ? 'E' : 'O'
      mainLogger.info('serial', `port opened: ${portName} @ ${options.baudRate} ${options.dataBits}${p}${options.stopBits} flow=${options.flowControl}`)
    } catch (e) {
      mainLogger.error('serial', `open failed: ${portName}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })

  // 关闭串口
  ipcMain.handle('serial:close', (event, portName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    mgr?.close(portName)
  })

  // 写入数据
  ipcMain.handle('serial:write', async (event, portName: string, data: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    if (!mgr) throw new Error('串口管理器不可用')
    return await mgr.write(portName, Buffer.from(data))
  })

  // 获取信号状态
  ipcMain.handle('serial:get-signals', async (event, portName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    return await mgr?.getSignals(portName) ?? { dcd: false, cts: false, dsr: false, ri: false }
  })

  // 设置输出控制线（DTR/RTS）
  ipcMain.handle('serial:set-signals', async (event, portName: string, signals: { dtr?: boolean; rts?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    if (!mgr) throw new Error('串口管理器不可用')
    await mgr.setSignals(portName, signals)
  })

  // 置/清 Break 条件
  ipcMain.handle('serial:set-break', async (event, portName: string, active: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    if (!mgr) throw new Error('串口管理器不可用')
    await mgr.setBreak(portName, active)
  })
}

/** 注册主进程日志相关 IPC handlers */
function registerLoggerIpc(): void {
  // 「导出日志」菜单的数据来源：返回全部日志文件内容（主进程事件 + 渲染端 console
  // 经 console-message 转发后都在这些文件里）。无需单独的 log:write 通道——
  // 渲染端任何 console 输出都会经 console-message 事件落到同一目录。
  ipcMain.handle('log:read', () => {
    return mainLogger.readAll()
  })
}

/** 注册应用自升级 IPC handlers（Updater 单例，状态经 updater:event 推送） */
function registerUpdaterIpc(updater: Updater): void {
  // 当前状态快照（渲染端挂载时同步，防事件早于订阅丢失）
  ipcMain.handle('updater:get-state', () => updater.getState())
  // 检查更新：进行中/下载中守卫幂等；非激活环境置 unavailable（不发起网络请求）
  ipcMain.handle('updater:check', () => updater.check())
  // 开始下载（仅 available 状态生效）；完成/失败/取消由 updater:event 驱动状态
  ipcMain.handle('updater:download', () => updater.download())
  // 取消进行中的下载（状态回到 available，可重新下载）
  ipcMain.handle('updater:cancel-download', () => updater.cancelDownload())
  // 退出并安装（渲染端负责在确认对话框提示录制/下发风险）
  ipcMain.handle('updater:quit-and-install', () => updater.quitAndInstall())
  // 手动下载兜底：系统浏览器打开 GitHub Releases 页
  ipcMain.handle('updater:open-releases', () => updater.openReleases())
}

/** 注册持久化镜像 IPC handlers（渲染端 localStorage 的权威副本落盘） */
function registerPersistIpc(store: JsonStore): void {
  // 渲染端每次 persistNow 调用触发，写入内存 store 并防抖落盘
  ipcMain.handle('persist:save', (_e, key: string, value: unknown) => {
    store.save(key, value)
    return true
  })

  // 容量告警时的全量快照导出（用户主动保存的文件）
  ipcMain.handle('persist:export-snapshot', async (event, content: string, fileName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const result = await dialog.showSaveDialog(win, {
      title: '保存配置快照',
      defaultPath: fileName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      fs.writeFileSync(result.filePath, content, 'utf-8')
      return true
    } catch (e) {
      mainLogger.error('persist', `snapshot write failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'KART',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 创建 serialport 管理器（绑定到本窗口，用于推送数据事件）
  _serialManagers.set(win.id, new SerialPortManager(win))
  // 创建本地 pty 管理器（本地终端验证用）
  _ptyManagers.set(win.id, new PtyManager(win))
  // 创建 TCP 管理器（TCP client 连接，多会话按端点管理）
  _tcpManagers.set(win.id, new TcpManager(win))

  // 转发渲染进程 console 到日志文件（保留源码位置便于定位）
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    mainLogger.handleConsoleMessage(level, message, line, sourceId)
  })

  // 页面加载失败时记录错误
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    mainLogger.error('renderer', `Failed to load ${url}: ${code} ${desc}`)
  })

  // 渲染进程崩溃/异常退出——用户报障时最关键的一条
  win.webContents.on('render-process-gone', (_e, details) => {
    mainLogger.error('main', `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  // 窗口关闭时清理录制写入流 + serialport 管理器（end 触发缓冲区最后一次刷新）
  win.on('closed', () => {
    // 流键为 `${winId}:${streamKey}`，按窗口前缀遍历清理该窗口的全部录制流
    const prefix = `${win.id}:`
    for (const [key, entry] of writeStreams) {
      if (key.startsWith(prefix)) {
        try { entry.stream.end() } catch { /* ignore */ }
        writeStreams.delete(key)
      }
    }
    _serialManagers.get(win.id)?.destroy()
    _serialManagers.delete(win.id)
    _ptyManagers.get(win.id)?.destroy()
    _ptyManagers.delete(win.id)
    _tcpManagers.get(win.id)?.destroy()
    _tcpManagers.delete(win.id)
  })

  if (devServerUrl) {
    // KART_PTY=1 时在 URL 追加 ?pty，渲染端据此把驱动切到本地终端（验证 vim 全屏）
    const url = process.env.KART_PTY === '1' ? `${devServerUrl}?pty` : devServerUrl
    mainLogger.info('main', `load dev server: ${url}`)
    win.loadURL(url)
  } else {
    const html = path.join(__dirname, '../../dist/index.html')
    // KART_PTY=1 时带 ?pty 加载（本地终端验证）；prod 下 loadFile 经 query 传参
    if (process.env.KART_PTY === '1') {
      win.loadFile(html, { query: { pty: '1' } })
    } else {
      win.loadFile(html)
    }
  }
}

app.whenReady().then(() => {
  mainLogger.init()
  mainLogger.info('main', `应用启动: v${app.getVersion()} electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node} platform=${process.platform}/${process.arch}`)
  jsonStore = new JsonStore()
  registerRecorderIpc()
  registerSerialPortIpc()
  registerPtyIpc()
  registerTcpIpc()
  registerLoggerIpc()
  registerPersistIpc(jsonStore)
  const updater = new Updater()
  registerUpdaterIpc(updater)
  configureWebSerial()

  Menu.setApplicationMenu(null)

  ipcMain.on('toggle-devtools', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.toggleDevTools()
  })

  createWindow()

  // 启动后延迟静默检查：有更新才推事件（渲染端弹窗），无更新不打扰。
  // 渲染端在 App 挂载即订阅 updater:event，5s 延迟保证订阅先于结果事件。
  updater.scheduleStartupCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// will-quit 里 preventDefault 后异步等待日志刷盘，再 app.exit 真正退出。
// app.exit 本身不再触发 will-quit，flushing flag 仅作防御性兜底；
// close() 带超时兜底，流卡死也不会阻塞退出流程。
let flushing = false
let jsonStore: JsonStore | null = null
app.on('will-quit', (event) => {
  if (flushing) return
  flushing = true
  event.preventDefault()
  jsonStore?.flushSync()
  mainLogger.info('main', '应用退出')
  mainLogger.close().finally(() => app.exit(0))
})
