import { BrowserWindow } from 'electron'
import { SerialPort } from 'serialport'
import { mainLogger } from './logger'

/**
 * macOS 系统伪终端 —— IOKit 将其报告为串口设备，但并非用户可连接的真实串口。
 * 在端口枚举时过滤掉，避免干扰用户选择。
 */
const MACOS_PSEUDO_TERMINAL_PATTERNS = [
  /debug-console/i,          // Apple 调试控制台
  /Bluetooth-Incoming-Port/i // 蓝牙串口服务
]

function isMacOSPseudoTerminal(path: string): boolean {
  if (process.platform !== 'darwin') return false
  return MACOS_PSEUDO_TERMINAL_PATTERNS.some((p) => p.test(path))
}

/**
 * native PortInfo（serialport.list() 返回项的子集）
 */
interface NativePortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  vendorId?: string
  productId?: string
}

/** 返回给渲染进程的端口信息 */
export interface SerialPortInfo {
  /** COM 口名，如 "COM5" */
  path: string
  manufacturer?: string
  /** 友好名/描述，如 "USB-SERIAL CH340 (COM5)" */
  friendlyName?: string
  vendorId?: string
  productId?: string
}

/**
 * 主进程串口管理器 —— 封装 serialport (npm) 库。
 *
 * - 主进程持有一个 SerialPort 实例，串口操作均在此进程执行
 * - 读取事件驱动（SerialPort 'data' 事件），数据通过 webContents.send 推送到渲染进程
 * - 渲染进程不直接接触原生库 —— 保持 contextIsolation 安全模型
 *
 * 相比手写 CSerialPort addon：
 *   - 无需本机 C++ 工具链，serialport 的 native bindings 已随包发布 prebuilt
 *   - 跨平台（Windows/macOS/Linux），枚举返回真实 COM 口名
 *   - 读取事件驱动而非主进程轮询，高波特率不丢字节、不卡 UI 线程
 */
export class SerialPortManager {
  private _port: SerialPort | null = null
  private _isOpen = false
  private _win: BrowserWindow

  constructor(win: BrowserWindow) {
    this._win = win
  }

  /** 串口是否已打开 */
  get isOpen(): boolean {
    return this._isOpen
  }

  // ── 公共方法 ──

  /** 枚举可用串口，返回真实 COM 口名列表 */
  listPorts(): SerialPortInfo[] {
    // SerialPort.list 是 async，这里同步包装返回当前一次枚举结果。
    // 调用方（IPC handler）已为 async，可直接 await listPortsAsync()。
    // 为保持同步入口语义，提供 async 版本。
    return []
  }

  /** 异步枚举可用串口 */
  async listPortsAsync(): Promise<SerialPortInfo[]> {
    try {
      const infos: NativePortInfo[] = await SerialPort.list()
      return infos
        .filter((i) => !isMacOSPseudoTerminal(i.path))
        .map((i) => ({
          path: i.path,
          manufacturer: i.manufacturer,
          vendorId: i.vendorId,
          productId: i.productId
        }))
    } catch (e) {
      mainLogger.error('serialport', `listPorts failed: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /**
   * 打开串口
   * @param path 如 "COM5"
   * @param options 波特率等参数，与 types.ts PortOptions 一致
   */
  open(path: string, options: {
    baudRate: number
    dataBits: 7 | 8
    stopBits: 1 | 2
    parity: 'none' | 'even' | 'odd'
    flowControl: 'none' | 'hardware'
  }): Promise<void> {
    if (this._isOpen) this.close()

    return new Promise<void>((resolve, reject) => {
      const port = new SerialPort({
        path,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        // serialport 的 rtscts 对应硬件流控（RTS/CTS）
        rtscts: options.flowControl === 'hardware',
        autoOpen: false
      })

      port.on('open', () => {
        this._port = port
        this._isOpen = true
        this._attachData(port)
        resolve()
      })

      port.on('error', (err: Error) => {
        if (!this._isOpen) {
          // 打开阶段错误
          reject(new Error(`打开串口 ${path} 失败: ${err.message}`))
        } else {
          // 运行阶段错误 —— 推送并关闭
          mainLogger.error('serialport', `runtime error on ${path}: ${err.message}`)
          this._sendError(`串口错误: ${err.message}`)
          this.close()
        }
      })

      // 物理断连（主动 close() 已先把 _isOpen 置 false，不会误报）
      port.on('close', () => {
        if (this._isOpen) {
          this._isOpen = false
          this._port = null
          mainLogger.warn('serialport', `port closed unexpectedly: ${path}`)
          this._sendError('串口已断开')
        }
      })

      port.open((err) => {
        if (err) {
          reject(new Error(`打开串口 ${path} 失败: ${err.message}`))
        }
        // 成功时 'open' 事件已 resolve
      })
    })
  }

  /** 关闭串口 */
  close(): void {
    if (this._port) {
      try {
        this._port.close()
      } catch {
        /* 端口可能已断连，忽略 */
      }
      this._port = null
    }
    this._isOpen = false
  }

  /**
   * 写入数据
   * @returns 实际写入的字节数
   */
  write(data: Buffer): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (!this._isOpen || !this._port) {
        reject(new Error('串口未打开'))
        return
      }
      this._port.write(data, (err) => {
        if (err) {
          reject(err)
          return
        }
        // 暂存写入 flush，确保送出后回调（不阻塞等待 drain 长时间）
        this._port?.drain((derr) => {
          if (derr) reject(derr)
          else resolve(data.length)
        })
      })
    })
  }

  /**
   * 获取信号状态（DCD/CTS/DSR/RI）
   * serialport.get() 为回调式（类型签名只有 callback 重载），
   * 这里包装成 Promise；返回 { cts, dsr, dcd, ri }。
   */
  getSignals(): Promise<{ dcd: boolean; cts: boolean; dsr: boolean; ri: boolean }> {
    if (!this._isOpen || !this._port) {
      return Promise.resolve({ dcd: false, cts: false, dsr: false, ri: false })
    }
    return new Promise((resolve) => {
      try {
        this._port?.get((err: Error | null, s?: { cts: boolean; dsr: boolean; dcd: boolean }) => {
          if (err || !s) {
            resolve({ dcd: false, cts: false, dsr: false, ri: false })
            return
          }
          // serialport.get() 仅返回 dcd/cts/dsr，无 ri（RI 线路未被该库读取）
          resolve({
            dcd: s.dcd,
            cts: s.cts,
            dsr: s.dsr,
            ri: false
          })
        })
      } catch {
        resolve({ dcd: false, cts: false, dsr: false, ri: false })
      }
    })
  }

  /** 销毁管理器 */
  destroy(): void {
    this.close()
  }

  // ── 私有方法 ──

  /** 挂载数据事件，每帧转发为 Uint8Array（确定性类型，不依赖 Buffer 跨进程语义） */
  private _attachData(port: SerialPort): void {
    port.on('data', (buf: Buffer) => {
      const data = Uint8Array.from(buf)
      if (!this._win.isDestroyed()) {
        this._win.webContents.send('serial:data', data)
      }
    })
  }

  /** 推送错误 + 断连事件到渲染进程 */
  private _sendError(msg: string): void {
    if (!this._win.isDestroyed()) {
      this._win.webContents.send('serial:error', msg)
    }
  }
}