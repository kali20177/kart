import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// 主/预加载产物以 CommonJS 输出（.cjs），__dirname 始终可用。
// vite-plugin-electron 在 dev 下注入 VITE_DEV_SERVER_URL，指向 Vite dev server。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

// 每个窗口一个活动的写入流（录制器用）
const writeStreams = new Map<number, fs.WriteStream>()

function registerRecorderIpc(): void {
  // 打开保存对话框
  ipcMain.handle('recorder:open-save-dialog', async (event, suggestedName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const ext = suggestedName.endsWith('.csv') ? 'csv' : 'txt'
    const name = suggestedName.endsWith('.csv') ? 'CSV Log' : 'Text Log'
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{
        name,
        extensions: [ext]
      }]
    })

    if (result.canceled || !result.filePath) return null

    const stream = fs.createWriteStream(result.filePath, { flags: 'a' })
    writeStreams.set(win.id, stream)

    return {
      filePath: result.filePath,
      fileName: path.basename(result.filePath)
    }
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
    // 生产：渲染产物在 dist/，主进程产物在 dist-electron/main/。
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerRecorderIpc()

  // 移除 Electron 默认菜单（File/Edit/View/Window/Help），
  // 避免与渲染进程的自定义 MenuBar 组件在 Windows/Linux 上冲突。
  Menu.setApplicationMenu(null)

  // 切换开发者工具（由渲染进程通过 IPC 触发）
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
