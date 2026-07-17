import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

const devServerUrl = process.env.VITE_DEV_SERVER_URL

// 每个窗口一个活动的写入流（录制器用）
const writeStreams = new Map<number, fs.WriteStream>()

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

  // 在指定目录中创建文件并打开写入流
  ipcMain.handle('recorder:create-file', async (event, dirPath: string, fileName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const fullPath = path.join(dirPath, fileName)
    const stream = fs.createWriteStream(fullPath, { flags: 'a' })
    writeStreams.set(win.id, stream)

    return { fileName }
  })

  // 将块写入已打开的文件
  ipcMain.on('recorder:write-chunk', (_event, windowId: number, chunk: Uint8Array) => {
    const stream = writeStreams.get(windowId)
    if (stream) {
      stream.write(Buffer.from(chunk))
    }
  })

  // 关闭文件流
  ipcMain.on('recorder:close-file', (_event, windowId: number) => {
    const stream = writeStreams.get(windowId)
    if (stream) {
      stream.end()
      writeStreams.delete(windowId)
    }
  })

  // 返回当前窗口 ID
  ipcMain.handle('recorder:get-window-id', (event) => {
    return event.sender.id
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

  // 窗口关闭时清理录制写入流
  win.on('closed', () => {
    const stream = writeStreams.get(win.id)
    if (stream) {
      stream.end()
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
