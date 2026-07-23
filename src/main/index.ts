import { app, BrowserWindow, Menu, ipcMain, dialog, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { SerialPortManager } from './SerialPortManager'

const devServerUrl = process.env.VITE_DEV_SERVER_URL

// 每个窗口的活动写入流及其最近一次写盘错误（录制器用）
interface ActiveStream {
  stream: fs.WriteStream
  lastError: string | null
}
const writeStreams = new Map<number, ActiveStream>()

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
  // 默认 flags:'w'（截断）——文件名按秒级时间戳唯一生成，无追加语义；
  // 用 'a' 会让 1 秒内同名重开或残留旧文件时把新内容拼到旧文件末尾造成数据污染。
  ipcMain.handle('recorder:create-file', async (event, dirPath: string, fileName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const fullPath = path.join(dirPath, fileName)
    const stream = fs.createWriteStream(fullPath, { flags: 'w' })
    const entry: ActiveStream = { stream, lastError: null }

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

    // 替换旧流（若有）：先正常关闭旧的，避免句柄泄漏
    const prev = writeStreams.get(win.id)
    if (prev) {
      try { prev.stream.end() } catch { /* ignore */ }
    }
    writeStreams.set(win.id, entry)

    return { fileName }
  })

  // 将块写入已打开的文件。返回 true 表示已提交到流（不代表已 fsync），
  // false 表示无打开流或流已出错——渲染进程据此把录制状态置为 error。
  ipcMain.handle('recorder:write-chunk', async (event, chunk: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const entry = writeStreams.get(win.id)
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
  ipcMain.handle('recorder:close-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return true
    const entry = writeStreams.get(win.id)
    if (!entry) return true
    writeStreams.delete(win.id)

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
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial')

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
    dataBits: 7 | 8
    stopBits: 1 | 2
    parity: 'none' | 'even' | 'odd'
    flowControl: 'none' | 'hardware'
  }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('窗口不存在')
    const mgr = _serialManagers.get(win.id)
    if (!mgr) throw new Error('串口管理器不可用')
    await mgr.open(portName, options)
  })

  // 关闭串口
  ipcMain.handle('serial:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    mgr?.close()
  })

  // 写入数据
  ipcMain.handle('serial:write', async (event, data: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    if (!mgr?.isOpen) throw new Error('串口未打开')
    return await mgr.write(Buffer.from(data))
  })

  // 获取信号状态
  ipcMain.handle('serial:get-signals', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    return await mgr?.getSignals() ?? { dcd: false, cts: false, dsr: false, ri: false }
  })

  // 检查串口是否已打开
  ipcMain.handle('serial:is-open', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const mgr = win ? _serialManagers.get(win.id) : null
    return mgr?.isOpen === true
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

  // 转发渲染进程 console 到终端（调试用）
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level === 3 ? 'ERR' : level === 1 ? 'WARN' : 'LOG'
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })

  // 页面加载失败时打印错误
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] FAILED to load ${url}: ${code} ${desc}`)
  })

  // 窗口关闭时清理录制写入流 + serialport 管理器（end 触发缓冲区最后一次刷新）
  win.on('closed', () => {
    const entry = writeStreams.get(win.id)
    if (entry) {
      try { entry.stream.end() } catch { /* ignore */ }
      writeStreams.delete(win.id)
    }
    _serialManagers.get(win.id)?.destroy()
    _serialManagers.delete(win.id)
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerRecorderIpc()
  registerSerialPortIpc()
  configureWebSerial()

  Menu.setApplicationMenu(null)

  ipcMain.on('toggle-devtools', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.toggleDevTools()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
