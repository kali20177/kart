import { BrowserWindow } from 'electron'
import net from 'node:net'
import { mainLogger } from './logger'

/**
 * 解析 "host:port" 端点字符串。仅支持 IPv4/hostname（IPv6 含多个冒号，暂不支持）。
 * 非法输入返回 null。
 */
export function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const idx = endpoint.lastIndexOf(':')
  if (idx <= 0 || idx === endpoint.length - 1) return null
  const host = endpoint.slice(0, idx)
  const port = Number(endpoint.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/** 单连接运行状态（socket 实例 + 是否打开） */
interface TcpEntry {
  socket: net.Socket
  isOpen: boolean
}

/**
 * 主进程 TCP client 管理器 —— 用 Node net 模块管理到远端的连接。
 *
 * - 主进程按端点 "host:port" 持有多个 net.Socket（多会话并排各自连接）
 * - 数据事件（'data'）经 webContents.send 推送到渲染进程，payload 携带端点标识，
 *   渲染端按 id 过滤分发——形态与 SerialPortManager 完全一致
 * - 断连语义：远端关闭/错误 → 推送 'tcp:error' 并清理，渲染端 TcpDriver 据此
 *   置 isOpen=false，走 serial store 的断连/自动重连流程
 */
export class TcpManager {
  private _conns = new Map<string, TcpEntry>()
  private _win: BrowserWindow

  constructor(win: BrowserWindow) {
    this._win = win
  }

  /** 连接远端（endpoint = "host:port"）。同一端点只允许一个连接。 */
  open(endpoint: string): Promise<void> {
    if (this._conns.has(endpoint)) {
      return Promise.reject(new Error(`连接已存在: ${endpoint}`))
    }
    const target = parseEndpoint(endpoint)
    if (!target) {
      return Promise.reject(new Error(`无效的 TCP 端点: ${endpoint}`))
    }

    return new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: target.host, port: target.port }, () => {
        this._conns.set(endpoint, { socket, isOpen: true })
        this._attachData(socket, endpoint)
        resolve()
      })

      socket.on('error', (err: Error) => {
        const entry = this._conns.get(endpoint)
        if (!entry?.isOpen) {
          // 连接阶段错误（如 ECONNREFUSED）
          reject(new Error(`连接 ${endpoint} 失败: ${err.message}`))
        } else {
          // 运行阶段错误 —— 推送并关闭
          mainLogger.error('tcp', `runtime error on ${endpoint}: ${err.message}`)
          this._sendError(endpoint, `连接错误: ${err.message}`)
          this.close(endpoint)
        }
      })

      // 远端断开：主动 close 已先删 entry，此处查不到 -> 不误报；
      // 真正断连 entry 仍在 -> 必须先发通知再删除（_sendError 依赖 entry 存在，
      // 否则其 has(endpoint) 守卫会吞掉通知，渲染端永远收不到断连事件 -> 自动重连失效）
      socket.on('close', () => {
        const entry = this._conns.get(endpoint)
        if (entry?.isOpen) {
          entry.isOpen = false
          mainLogger.warn('tcp', `connection closed unexpectedly: ${endpoint}`)
          this._sendError(endpoint, '连接已断开')
          this._conns.delete(endpoint)
        }
      })
    })
  }

  /** 关闭指定连接 */
  close(endpoint: string): void {
    const entry = this._conns.get(endpoint)
    if (!entry) return
    // 先删 entry 再触发 close——'close' 事件回调查不到 entry，不会误报「已断开」
    this._conns.delete(endpoint)
    try {
      entry.socket.end()
      entry.socket.destroy()
    } catch {
      /* 连接可能已断开，忽略 */
    }
  }

  /** 写入数据（await socket.write 回调） */
  write(endpoint: string, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry = this._conns.get(endpoint)
      if (!entry?.isOpen) {
        reject(new Error('连接未打开'))
        return
      }
      entry.socket.write(data, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** 销毁管理器：关闭全部连接 */
  destroy(): void {
    for (const endpoint of [...this._conns.keys()]) {
      this.close(endpoint)
    }
  }

  // ── 私有方法 ──

  /** 挂载数据事件，每帧转发为 Uint8Array（确定性类型，不依赖 Buffer 跨进程语义） */
  private _attachData(socket: net.Socket, endpoint: string): void {
    socket.on('data', (buf: Buffer) => {
      // 连接已关闭后丢弃残留事件
      if (!this._conns.get(endpoint)?.isOpen) return
      const data = Uint8Array.from(buf)
      if (!this._win.isDestroyed()) {
        this._win.webContents.send('tcp:data', { id: endpoint, data })
      }
    })
  }

  /** 推送错误 + 断连事件到渲染进程 */
  private _sendError(endpoint: string, msg: string): void {
    if (!this._conns.has(endpoint)) return
    if (!this._win.isDestroyed()) {
      this._win.webContents.send('tcp:error', { id: endpoint, msg })
    }
  }
}
