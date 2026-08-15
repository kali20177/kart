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

/** 单端口占用探测超时（ms）：某端口 open 挂起时不阻塞整个枚举，超时视为不占用 */
const PROBE_TIMEOUT_MS = 1000

function isMacOSPseudoTerminal(path: string): boolean {
  if (process.platform !== 'darwin') return false
  return MACOS_PSEUDO_TERMINAL_PATTERNS.some((p) => p.test(path))
}

/**
 * 把 serialport 打开失败映射为可读文案。占用类错误（端口锁/忙/访问拒绝）单独提示——
 * 覆盖两个独立 KART 实例（进程）连同一串口、minicom/其他串口助手占用等场景；
 * 其余保留原始错误信息，用户能区分「被其他程序占用」与真正的设备/驱动问题。
 */
function toFriendlyOpenError(path: string, err: Error): Error {
  if (/lock|busy|in use|temporarily unavailable|access is denied|cannot open/i.test(err.message)) {
    return new Error(`端口 ${path} 已被其他程序占用，请先关闭占用方再连接`)
  }
  return new Error(`打开串口 ${path} 失败: ${err.message}`)
}

/**
 * macOS 上 serialport 枚举返回 dialin 节点（/dev/tty.*），而串口工具惯例使用
 * callout 节点（/dev/cu.*，打开不等待 DCD）。同一物理设备的两个 BSD 节点同基名，
 * 这里把 tty 路径换算成 cu 路径，让 UI 显示规范名。非 darwin / 非 tty 路径原样返回。
 */
export function toCalloutPath(path: string, platform: string = process.platform): string {
  if (platform !== 'darwin' || !path.startsWith('/dev/tty.')) return path
  return '/dev/cu.' + path.slice('/dev/tty.'.length)
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
  /** 是否被其他程序占用（枚举时探测的瞬时快照；KART 自身已打开的不算） */
  busy?: boolean
}

/** 单端口运行状态（port 实例 + 是否打开） */
interface PortEntry {
  port: SerialPort
  isOpen: boolean
}

/**
 * 主进程串口管理器 —— 封装 serialport (npm) 库。
 *
 * - 主进程按端口路径持有多个 SerialPort 实例，串口操作均在此进程执行
 * - 读取事件驱动（SerialPort 'data' 事件），数据经 webContents.send 推送到渲染进程，
 *   payload 携带端口路径，渲染端按路径过滤分发
 * - 渲染进程不直接接触原生库 —— 保持 contextIsolation 安全模型
 *
 * 相比手写 CSerialPort addon：
 *   - 无需本机 C++ 工具链，serialport 的 native bindings 已随包发布 prebuilt
 *   - 跨平台（Windows/macOS/Linux），枚举返回真实 COM 口名
 *   - 读取事件驱动而非主进程轮询，高波特率不丢字节、不卡 UI 线程
 */
export class SerialPortManager {
  private _ports = new Map<string, PortEntry>()
  private _win: BrowserWindow

  constructor(win: BrowserWindow) {
    this._win = win
  }

  // ── 公共方法 ──

  /** 枚举可用串口，返回真实 COM 口名列表 */
  listPorts(): SerialPortInfo[] {
    // SerialPort.list 是 async，这里同步包装返回当前一次枚举结果。
    // 调用方（IPC handler）已为 async，可直接 await listPortsAsync()。
    // 为保持同步入口语义，提供 async 版本。
    return []
  }

  /** 异步枚举可用串口，并附带物理占用探测（busy）结果 */
  async listPortsAsync(): Promise<SerialPortInfo[]> {
    try {
      const infos: NativePortInfo[] = await SerialPort.list()
      const ports = infos
        .filter((i) => !isMacOSPseudoTerminal(i.path))
        .map((i) => ({
          path: toCalloutPath(i.path),
          manufacturer: i.manufacturer,
          vendorId: i.vendorId,
          productId: i.productId
        }))
      // 并行探测各端口占用（serialport list 不提供 busy 状态），busy 一并返回。
      // 逐端口兜底：单个端口探测失败（异常/超时）不影响整个枚举，缺失标记为未占用
      const busyFlags = await Promise.all(
        ports.map((p) => this.probePortBusy(p.path).catch(() => false))
      )
      return ports.map((p, idx) => ({ ...p, busy: busyFlags[idx] }))
    } catch (e) {
      mainLogger.error('serialport', `listPorts failed: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /**
   * 探测单端口是否被其他程序占用（物理 busy）。
   *
   * 策略：尝试独占打开该端口——
   * - 打开成功：空闲（立即关闭释放，探测不留句柄）；返回 false
   * - 打开失败（EBUSY/AccessError 等）：被占用或不可用；返回 true
   * - 超时：视为不占用（避免误报让用户连不上）
   *
   * 探测以 dtr:false/rts:false 打开，尽量不扰动设备电平（Arduino 等按 DTR 复位
   * 的设备不受影响）。KART 自身已打开的端口（_ports 中）跳过探测——本应用占用
   * 不属「其他程序」，由渲染端 occupiedPorts 提示。
   */
  async probePortBusy(path: string): Promise<boolean> {
    if (this._ports.has(path)) return false
    return new Promise<boolean>((resolve) => {
      let port: SerialPort
      try {
        // 必须传 baudRate：serialport 各平台 binding 在 open 时校验 baudRate，缺失会同步抛
        // TypeError（且不走到真正的锁检测）——探测会漏掉所有被占用端口
        port = new SerialPort({ path, baudRate: 9600, autoOpen: false, dtr: false, rts: false })
      } catch {
        // 构造失败（端口刚拔出/路径无效等）视为不占用，绝不 reject——否则会打穿整个枚举
        resolve(false)
        return
      }
      let settled = false
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
      function done(busy: boolean) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(busy)
      }
      port.on('open', () => {
        // 打开成功说明空闲：立即关闭释放。close 为 fire-and-forget（不阻塞返回）；
        // 超时后再成功打开也走此路径关闭，避免句柄泄漏
        port.close()
        done(false)
      })
      port.on('error', () => done(true))
      try {
        port.open((err) => {
          if (err) done(true)
          // 成功路径由 'open' 事件收尾
        })
      } catch {
        // open 同步抛异常（极端情况）：视为不占用，避免 reject 打穿枚举
        done(false)
      }
    })
  }

  open(path: string, options: {
    baudRate: number
    dataBits: 5 | 6 | 7 | 8
    stopBits: 1 | 1.5 | 2
    parity: 'none' | 'even' | 'odd'
    flowControl: 'none' | 'hardware'
  }): Promise<void> {
    // 同一端口只允许一个打开者（物理设备不可共享），复用会掩盖多会话冲突
    if (this._ports.has(path)) {
      return Promise.reject(new Error(`串口已被占用: ${path}`))
    }

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
        this._ports.set(path, { port, isOpen: true })
        this._attachData(port, path)
        resolve()
      })

      port.on('error', (err: Error) => {
        const entry = this._ports.get(path)
        if (!entry || !entry.isOpen) {
          // 打开阶段错误
          reject(toFriendlyOpenError(path, err))
        } else {
          // 运行阶段错误 —— 推送并关闭
          mainLogger.error('serialport', `runtime error on ${path}: ${err.message}`)
          this._sendError(path, `串口错误: ${err.message}`)
          this.close(path)
        }
      })

      // 物理断连：主动 close(path) 已先删除 entry，此处查不到 -> 不误报；
      // 真正的物理断连 entry 仍在 -> 必须先发通知再删除（_sendError 依赖 entry 存在，
      // 否则其 has(path) 守卫会吞掉通知，渲染端永远收不到断连事件 -> 自动重连失效）
      port.on('close', () => {
        const entry = this._ports.get(path)
        if (entry?.isOpen) {
          entry.isOpen = false
          mainLogger.warn('serialport', `port closed unexpectedly: ${path}`)
          this._sendError(path, '串口已断开')
          this._ports.delete(path)
        }
      })

      port.open((err) => {
        if (err) {
          reject(toFriendlyOpenError(path, err))
        }
        // 成功时 'open' 事件已 resolve
      })
    })
  }

  /** 关闭指定串口 */
  close(path: string): void {
    const entry = this._ports.get(path)
    if (!entry) return
    // 先删 entry 再触发 close——'close' 事件回调查不到 entry，不会误报「已断开」
    this._ports.delete(path)
    try {
      entry.port.close()
    } catch {
      /* 端口可能已断连，忽略 */
    }
  }

  /**
   * 写入数据
   * @returns 实际写入的字节数
   */
  write(path: string, data: Buffer): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const entry = this._ports.get(path)
      if (!entry?.isOpen) {
        reject(new Error('串口未打开'))
        return
      }
      entry.port.write(data, (err) => {
        if (err) {
          reject(err)
          return
        }
        // 暂存写入 flush，确保送出后回调（不阻塞等待 drain 长时间）
        entry.port.drain((derr) => {
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
  getSignals(path: string): Promise<{ dcd: boolean; cts: boolean; dsr: boolean; ri: boolean }> {
    const entry = this._ports.get(path)
    if (!entry?.isOpen) {
      return Promise.resolve({ dcd: false, cts: false, dsr: false, ri: false })
    }
    return new Promise((resolve) => {
      try {
        entry.port.get((err: Error | null, s?: { cts: boolean; dsr: boolean; dcd: boolean }) => {
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

  /**
   * 设置输出控制线（DTR/RTS）。serialport.set 只更新传入的属性，
   * 未提供的项保持当前值不变。
   */
  setSignals(path: string, signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    const entry = this._ports.get(path)
    if (!entry?.isOpen) {
      return Promise.reject(new Error('串口未打开'))
    }
    return new Promise((resolve, reject) => {
      const opts: Record<string, boolean> = {}
      if (signals.dtr !== undefined) opts.dtr = signals.dtr
      if (signals.rts !== undefined) opts.rts = signals.rts
      entry.port.set(opts, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * 置/清 Break 条件（TX 拉低）。serialport.set({ brk }) 的 brk=true 置位、
   * brk=false 清除；部分虚拟/蓝牙串口可能不支持而报错。
   */
  setBreak(path: string, active: boolean): Promise<void> {
    const entry = this._ports.get(path)
    if (!entry?.isOpen) {
      return Promise.reject(new Error('串口未打开'))
    }
    return new Promise((resolve, reject) => {
      entry.port.set({ brk: active }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** 销毁管理器：关闭全部端口 */
  destroy(): void {
    for (const path of [...this._ports.keys()]) {
      this.close(path)
    }
  }

  // ── 私有方法 ──

  /** 挂载数据事件，每帧转发为 Uint8Array（确定性类型，不依赖 Buffer 跨进程语义） */
  private _attachData(port: SerialPort, path: string): void {
    port.on('data', (buf: Buffer) => {
      // 端口已关闭后丢弃残留事件
      if (!this._ports.get(path)?.isOpen) return
      const data = Uint8Array.from(buf)
      if (!this._win.isDestroyed()) {
        this._win.webContents.send('serial:data', { path, data })
      }
    })
  }

  /** 推送错误 + 断连事件到渲染进程 */
  private _sendError(path: string, msg: string): void {
    if (!this._ports.has(path)) return
    if (!this._win.isDestroyed()) {
      this._win.webContents.send('serial:error', { path, msg })
    }
  }
}
