import type { MockScenarioId, PortOptions, SerialSignals } from '@/types'
import {
  atResponse,
  binaryFrame,
  gbkSample,
  logLine,
  throughputChunk,
  waveformChunk
} from './scenarios'

/**
 * 串口驱动接口 —— Mock 与未来的 Web Serial 实现共享这一契约。
 * 阶段 2 只需写一个实现该接口的 WebSerialDriver，serial store 不动。
 */
export interface SerialDriver {
  listPorts(): Promise<string[]>
  open(path: string, options: PortOptions): Promise<void>
  close(): Promise<void>
  write(bytes: Uint8Array): Promise<void>
  getSignals(): SerialSignals
  /** 订阅接收数据，返回取消订阅函数 */
  onData(cb: (bytes: Uint8Array) => void): () => void
  readonly isOpen: boolean
}

/** 模拟串口源：用定时器代替真实硬件，提供多种调试场景 */
export class MockSerialSource implements SerialDriver {
  private listeners = new Set<(bytes: Uint8Array) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private scenario: MockScenarioId = 'at-reply'
  private seq = 0
  private _isOpen = false
  private signals: SerialSignals = { dcd: true, cts: true, dsr: true, ri: false }

  get isOpen() {
    return this._isOpen
  }

  async listPorts(): Promise<string[]> {
    return ['COM3', 'COM7', '/dev/ttyUSB0']
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
      case 'waveform':
        // 每 50ms 一帧 128 字节 = 32 采样 → 640 采样/秒，匹配默认 sampleRate:640
        this.timer = setInterval(() => this.emit(waveformChunk(this.seq++)), 50)
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
  }
}
