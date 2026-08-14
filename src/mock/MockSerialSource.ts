import type { EndpointInfo, IoTransport, PortOptions, SerialSignals, DriverType, MockScenarioId } from '@/types'
import {
  atResponse,
  binaryFrame,
  bufferFloodChunk,
  gbkSample,
  logLine,
  modbusSample,
  throughputChunk,
  waveformTextChunk,
  waveformTextLabeledChunk,
  shellBanner,
  MockShell
} from './scenarios'

/** 模拟串口源：用定时器代替真实硬件，提供多种调试场景 */
export class MockSerialSource implements IoTransport {
  readonly type: DriverType = 'mock'
  private listeners = new Set<(bytes: Uint8Array) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private bannerTimer: ReturnType<typeof setTimeout> | null = null
  private scenario: MockScenarioId = 'at-reply'
  private shell = new MockShell()
  private seq = 0
  private _isOpen = false
  private signals: SerialSignals = { dcd: true, cts: true, dsr: true, ri: false }
  private _outputSignals = { dtr: false, rts: false }
  private _break = false

  get isOpen() {
    return this._isOpen
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    // 造假的完整元数据，用于开发模式预览下拉两行效果
    return [
      { path: 'COM3', manufacturer: 'QinHeng Electronics (CH340/CH341)', vendorId: '1a86', productId: '7523' },
      { path: 'COM7', manufacturer: 'Silicon Labs (CP210x)', vendorId: '10c4', productId: 'ea60' },
      { path: '/dev/ttyUSB0', manufacturer: 'FTDI (FT232R/FT2232)', vendorId: '0403', productId: '6001' }
    ]
  }

  async open(_path: string, _options: PortOptions): Promise<void> {
    this._isOpen = true
    this.seq = 0
    this.startScenarioTimer()
  }

  async close(): Promise<void> {
    this._isOpen = false
    this.stopTimer()
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this._isOpen) throw new Error('端口未打开')
    // Shell 场景：设备侧回显 + 行编辑 + 命令应答（模拟嵌入式 Linux console）
    if (this.scenario === 'shell') {
      this.emit(this.shell.process(bytes))
      return
    }
    // AT 应答场景：发送后延时回包
    if (this.scenario === 'at-reply') {
      const sent = new TextDecoder().decode(bytes)
      const delay = 50 + Math.floor(Math.random() * 150)
      setTimeout(() => this.emit(atResponse(sent)), delay)
    }
  }

  getSignals(): SerialSignals {
    return { ...this.signals }
  }

  /** 记录 DTR/RTS 输出线状态（mock 无真实硬件，仅保存供 UI 反映与断言） */
  async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (!this._isOpen) throw new Error('端口未打开')
    if (signals.dtr !== undefined) this._outputSignals.dtr = signals.dtr
    if (signals.rts !== undefined) this._outputSignals.rts = signals.rts
  }

  /** 记录 Break 状态（mock 无真实硬件，仅保存供断言） */
  async setBreak(active: boolean): Promise<void> {
    if (!this._isOpen) throw new Error('端口未打开')
    this._break = active
  }

  /** 当前输出的 DTR/RTS 状态（测试断言用） */
  get outputSignals() {
    return { ...this._outputSignals }
  }

  /** 当前 Break 状态（测试断言用） */
  get breakActive() {
    return this._break
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 切换场景 */
  setScenario(id: MockScenarioId) {
    this.scenario = id
    if (this._isOpen) this.startScenarioTimer()
  }

  /** 手动注入一段数据（设置面板的"注入"按钮用） */
  inject(bytes: Uint8Array) {
    if (this._isOpen) this.emit(bytes)
  }

  private emit(bytes: Uint8Array) {
    for (const cb of this.listeners) cb(bytes)
  }

  private startScenarioTimer() {
    this.stopTimer()
    switch (this.scenario) {
      case 'binary-frames':
        this.timer = setInterval(() => this.emit(binaryFrame(this.seq++)), 800)
        break
      case 'modbus':
        // 每 800ms 一条 Modbus RTU 帧（fc03 应答为主，穿插请求），验证 Modbus RTU 解码器
        this.timer = setInterval(() => this.emit(modbusSample(this.seq++)), 800)
        break
      case 'high-throughput':
        // 每 8ms 吐一段，模拟高波特率连续流
        this.timer = setInterval(() => {
          for (let i = 0; i < 4; i++) this.emit(throughputChunk(this.seq++))
        }, 8)
        break
      case 'mixed-ascii':
        this.timer = setInterval(() => {
          if (this.seq % 5 === 0) this.emit(gbkSample())
          else this.emit(logLine(this.seq))
          this.seq++
        }, 600)
        break
      case 'waveform-text':
        // 每 50ms 一行 ASCII 数字 -> 20 行/秒，配合文本行解析 + 采样率 20
        this.timer = setInterval(() => this.emit(waveformTextChunk(this.seq++)), 50)
        break
      case 'waveform-text-labeled':
        // 每 50ms 一行标签化文本（Sin:xxx,Cos:xxx）-> 20 行/秒，自动检测通道名
        this.timer = setInterval(() => this.emit(waveformTextLabeledChunk(this.seq++)), 50)
        break
      case 'buffer-flood':
        // 每 50ms 吐 500 行数值 -> 分隔符策略下 500 帧/批，数秒灌满缓冲上限触发丢弃提示
        this.timer = setInterval(() => this.emit(bufferFloodChunk()), 50)
        break
      case 'shell':
        // 事件驱动：连接后打印 banner，之后由 write() 回显+应答
        this.bannerTimer = setTimeout(() => this.emit(shellBanner()), 150)
        break
      case 'silent':
      case 'at-reply':
      default:
        // 无自动数据
        break
    }
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.bannerTimer) {
      clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }
}
