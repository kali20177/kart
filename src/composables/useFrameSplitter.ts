import type { FrameConfig } from '@/types'
import { parseHexInput } from '@/utils/hex'

/**
 * 帧切分器：把零散到达的字节流按策略切成"一帧帧"，避免每个底层 chunk 都成为一个气泡。
 *
 * 设计为纯逻辑类（不含定时器），便于单测：
 *   - push(bytes, now) 返回本次"已完整"的帧（可能为空）
 *   - gap-timeout 策略下，尾帧需要外部在静默 gapMs 后调用 flush() 取出
 *   - delimiter / fixed-length 策略在 push 内即可切出完整帧，剩余留在 buffer
 */
export class FrameSplitter {
  private buffer: number[] = []
  private lastTime = 0
  private delimiter: Uint8Array

  constructor(private config: FrameConfig) {
    this.delimiter = this.parseDelimiter(config)
  }

  /** 运行时更新配置（设置变更时调用） */
  setConfig(config: FrameConfig) {
    this.config = config
    this.delimiter = this.parseDelimiter(config)
  }

  private parseDelimiter(config: FrameConfig): Uint8Array {
    const r = parseHexInput(config.delimiterHex || '0A')
    return r.ok && r.bytes.length > 0 ? r.bytes : new Uint8Array([0x0a])
  }

  /** 推入新到达的字节，返回本次切出的完整帧 */
  push(bytes: Uint8Array, now: number): Uint8Array[] {
    const frames: Uint8Array[] = []

    switch (this.config.strategy) {
      case 'gap-timeout': {
        // 新一批到达时间距上批超过 gapMs → 先把已有 buffer 收成一帧
        if (this.buffer.length > 0 && now - this.lastTime > this.config.gapMs) {
          frames.push(this.take())
        }
        for (const b of bytes) this.buffer.push(b)
        this.lastTime = now
        break
      }
      case 'delimiter': {
        for (const b of bytes) this.buffer.push(b)
        frames.push(...this.splitByDelimiter())
        break
      }
      case 'fixed-length': {
        for (const b of bytes) this.buffer.push(b)
        const n = Math.max(1, this.config.fixedLength)
        while (this.buffer.length >= n) {
          frames.push(new Uint8Array(this.buffer.splice(0, n)))
        }
        break
      }
    }
    return frames
  }

  /** 取出并清空当前 buffer 作为一帧（gap-timeout 尾帧 / 强制刷新用） */
  flush(): Uint8Array[] {
    return this.buffer.length > 0 ? [this.take()] : []
  }

  private take(): Uint8Array {
    const frame = new Uint8Array(this.buffer)
    this.buffer = []
    return frame
  }

  private splitByDelimiter(): Uint8Array[] {
    const frames: Uint8Array[] = []
    const delim = this.delimiter
    let start = 0
    for (let i = 0; i + delim.length <= this.buffer.length; i++) {
      let match = true
      for (let j = 0; j < delim.length; j++) {
        if (this.buffer[i + j] !== delim[j]) {
          match = false
          break
        }
      }
      if (match) {
        // 含分隔符一并归入该帧（嵌入式日志里通常希望保留 \r\n）
        const end = i + delim.length
        frames.push(new Uint8Array(this.buffer.slice(start, end)))
        start = end
        i = end - 1
      }
    }
    if (start > 0) this.buffer = this.buffer.slice(start)
    return frames
  }
}
