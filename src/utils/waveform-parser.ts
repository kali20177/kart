import { parseTextSamples } from './text-parser'

/**
 * 波形解析器接口：把连续字节流解析为多通道采样。
 *
 * 每个解析器**自持全部协议相关状态**（carryover 零头、标签索引、上一个采样 X 等），
 * store 仅通过此接口委托，不感知协议细节。这是多协议扩展的接缝：
 *
 *   - 新增协议 = 新增一个实现类（如未来的 BinaryStreamParser），自带其 carryover 类型与 X 策略；
 *   - store 的 ingest() 函数体不随协议增长分支——只调 parser.ingest()、追加结果。
 *
 * X 时间戳策略由解析器拥有：文本模式 1 行 = 1 采样，X 用真实到达时间 + 逐行 +1ms 保单调；
 * 未来的二进制模式 N 采样/帧可另选策略（如帧首锚定真实时间、帧内按 dt 插值），与 store 解耦。
 */

export interface WaveformParserResult {
  /** 本批新增采样的 X 时间戳（毫秒），与 perChannel 各通道等长 */
  xs: number[]
  /** 每通道新增采样值；perChannel[c][s] 对应 xs[s]，缺失值用 NaN 占位 */
  perChannel: number[][]
}

export interface WaveformParser {
  /** 解析一批字节 → 新增采样。now 为本批到达的真实时间戳，供解析器构造 X。 */
  ingest(bytes: Uint8Array, now: number): WaveformParserResult
  /** 当前通道标签名（无标签数据为空数组；store 同步到响应式 textLabels） */
  readonly labels: readonly string[]
  /** 重置内部状态（carryover / labelIndex / lastSampleX）；清空或切换协议时调用 */
  reset(): void
}

/**
 * 文本行解析器（Arduino Serial.println 风格）。
 *
 * 持有跨回调状态：半截行字符串 carryover、标签→通道索引 labelIndex、labels 数组、
 * 上一个采样 X（保单调）。纯解析逻辑复用 parseTextSamples（无状态纯函数，可独立单测）。
 *
 * X 策略：1 行 = 1 采样，X = max(now, lastSampleX + 1)，逐行 +1ms。
 * 文本到达速率未知且可变（Arduino loop 周期 / delay），故用真实到达时间而非合成时间。
 */
export class TextLineParser implements WaveformParser {
  private carryover = ''
  private labelIndex: Map<string, number> = new Map()
  private _labels: string[] = []
  private lastSampleX = -Infinity

  ingest(bytes: Uint8Array, now: number): WaveformParserResult {
    const { perChannel, remainder } = parseTextSamples(bytes, this.carryover, this.labelIndex)
    this.carryover = remainder

    // 同步 labelIndex → labels：新标签出现时按索引补位
    if (this.labelIndex.size !== this._labels.length) {
      const arr = this._labels.slice()
      for (const [label, idx] of this.labelIndex) {
        arr[idx] = label
      }
      this._labels = arr
    }

    const n = perChannel[0]?.length ?? 0
    const xs: number[] = []
    if (n > 0) {
      let x = Math.max(now, this.lastSampleX + 1)
      for (let s = 0; s < n; s++) {
        xs.push(x)
        x++
      }
      this.lastSampleX = xs[xs.length - 1]
    }
    return { xs, perChannel }
  }

  get labels(): readonly string[] {
    return this._labels
  }

  reset(): void {
    this.carryover = ''
    this.labelIndex = new Map()
    this._labels = []
    this.lastSampleX = -Infinity
  }
}
