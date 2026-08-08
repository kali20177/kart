import { BrowserWindow, app } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { mainLogger } from './logger'

interface PtyEntry {
  pty: IPty
}

/**
 * 本地 pty 终端管理器 —— 封装 node-pty。
 *
 * 用途：在 Electron 内直接 spawn 一个本地 shell（bash/zsh），作为「本地终端」
 * 数据源验证终端视图（vim/nano 全屏、真实行编辑、ANSI 色彩）。pty 输出经
 * 'pty:data' 推送到渲染进程，输入经 write 写入，尺寸经 resize 同步给 shell。
 *
 * 与 SerialPortManager 平行：每窗口一个实例，渲染进程数据事件按 id 分发。
 */
export class PtyManager {
  private _ptys = new Map<string, PtyEntry>()
  private _win: BrowserWindow

  constructor(win: BrowserWindow) {
    this._win = win
  }

  /** 启动一个本地 shell。shell 取自 $SHELL（macOS 默认 /bin/zsh）。 */
  open(id: string, options: { cols: number; rows: number }): void {
    if (this._ptys.has(id)) throw new Error(`pty 已存在: ${id}`)
    const shell = process.env.SHELL || '/bin/bash'
    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: app.getPath('home'),
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    pty.onData((data) => {
      if (this._win.isDestroyed()) return
      this._win.webContents.send('pty:data', { id, data })
    })
    pty.onExit(({ exitCode, signal }) => {
      if (!this._win.isDestroyed()) {
        this._win.webContents.send('pty:exit', { id, exitCode, signal })
      }
      this._ptys.delete(id)
    })
    this._ptys.set(id, { pty })
    mainLogger.info('pty', `local shell spawned: ${shell} (${id}) @ ${options.cols}x${options.rows}`)
  }

  write(id: string, data: string): void {
    this._ptys.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this._ptys.get(id)
    if (!entry) return
    try {
      entry.pty.resize(cols, rows)
    } catch (e) {
      mainLogger.warn('pty', `resize failed (${id}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  close(id: string): void {
    const entry = this._ptys.get(id)
    if (!entry) return
    this._ptys.delete(id)
    try {
      entry.pty.kill()
    } catch {
      /* 进程可能已退出，忽略 */
    }
  }

  /** 关闭全部 pty（窗口关闭时调用） */
  destroy(): void {
    for (const id of [...this._ptys.keys()]) this.close(id)
  }
}
