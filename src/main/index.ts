import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '串口调试助手',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 窗口关闭时清理录制写入流（end 触发缓冲区最后一次刷新）
  win.on('closed', () => {
    const entry = writeStreams.get(win.id)
    if (entry) {
      try { entry.stream.end() } catch { /* ignore */ }
      writeStreams.delete(win.id)
    }
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerRecorderIpc()

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
