import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

// 主/预加载产物以 CommonJS 输出（.cjs），__dirname 始终可用。
// vite-plugin-electron 在 dev 下注入 VITE_DEV_SERVER_URL，指向 Vite dev server。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

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

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    // 生产：渲染产物在 dist/，主进程产物在 dist-electron/main/。
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
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
