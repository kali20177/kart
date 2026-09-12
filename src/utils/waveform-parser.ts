import { parseTextSamples } from './text-parser'
import { bitsPerByte, byteTimeMs, wireBatchXs, type WireClockConfig } from './waveform-clock'

/**
 * 波形解析器接口：把连续字节流解析为多通道采样。
 *
 * 每个解析器**自持全部协议相关状态**（carryover 零头、标签索引、上一个采样 X 等），
 * store 仅通过此接口委托，不感知协议细节。这是多协议扩展的接缝：
 *
 *   - 新增协议 = 新增实现类（如未来的 BinaryStreamParser），自带其 carryover 类型与 X 策略；
 *   - store 的 ingest() 函数体不随协议增长分支——只调 parser.ingest()、追加结果。
 *
 * X 时间戳策略由解析器拥有：文本模式 1 行 = 1 采样。串口域（wire clock 注入）按
 * 波特率位时间合成「线缆时刻」；无注入或网络域走到达时间（见 waveform-clock 注释）。
 * 未来的二进制模式 N 采样/帧可另选策略，与 store 解耦。
 */

export interface WaveformParserResult {
  /** 本批新增采样的 X 时间戳（毫秒），与 perChannel 各通道等长 */
  xs: number[]
  /** 每通道新增采样值；perChannel[c][s] 对应 xs[s]，缺失值用 NaN 占位 */
  perChannel: number[][]
}

export interface WaveformParser {
  /** 解析一批字节 → 新增采样。now 为本批到达的真实时间戳，供到达域/锚点使用。 */
  ingest(bytes: Uint8Array, now: number): WaveformParserResult
  /** 当前通道标签名（无标签数据为空数组；store 同步到响应式 textLabels） */
  readonly labels: readonly string[]
  /** 重置内部状态（carryover / labelIndex / lastSampleX / 时钟锚点）；清空或切换协议时调用 */
  reset(): void
}

/** 复用同一编码器（encode 无状态），避免每批新建实例 */
const utf8Encoder = new TextEncoder()

/** 字符串的 UTF-8 字节长度（合成时钟的字节归属统计用） */
function encodeUtf8Length(s: string): number {
  return s.length === 0 ? 0 : utf8Encoder.encode(s).length
}

/**
 * 文本行解析器（Arduino Serial.println 风格）。
 *
 * 持有跨回调状态：半截行字符串 carryover、标签→通道索引 labelIndex、labels 数组、
 * 上一个采样 X（保单调）。纯解析逻辑复用 parseTextSamples（无状态纯函数，可独立单测）。
 *
 * X 策略（时钟权威，见 waveform-clock.ts）：
 *  - 注入 clock 且域为 wire（串口系）：X = 批锚定位时钟——本批完整行线缆字节数
 *    （含上批遗留 carryover 的归属校正）× 每字节位时间均摊到 n 条样本；锚点
 *    base = max(now, lastSampleX) 保留批间空档（设备暂停），消除批内 +1ms 假间距与合批 clump；
 *  - 未注入 clock 或域为 arrival（TCP/RTT 等）：X = max(now, lastSampleX + 1)，逐行 +1ms
 *    保单调（历史行为，网络域无波特率语义、无改进空间）。
 *  - 两域共用 lastSampleX 作单调下限：切域时 X 不回跳（uPlot 要求严格递增），真实时间
 *    只向前走，新域实际仍锚定 now。
 */
export class TextLineParser implements WaveformParser {
  private carryover = ''
  /** 当前 carryover（半截行）对应的原始字节数——跨批统计完整行字节时用于归属校正 */
  private remainderBytes = 0
  private labelIndex: Map<string, number> = new Map()
  private _labels: string[] = []
  private lastSampleX = -Infinity
  private clock?: () => WireClockConfig

  constructor(clock?: () => WireClockConfig) {
    this.clock = clock
  }

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
    const xs = this.makeXs(bytes.length, remainder, n, now)
    if (n > 0) this.lastSampleX = xs[xs.length - 1]
    return { xs, perChannel }
  }

  /** 按当前时钟域生成本批 X；空批（n=0）返回空数组。carryover 字节数无条件跟进。 */
  private makeXs(byteCount: number, remainder: string, n: number, now: number): number[] {
    // 半截行的字节数必须每批跟进（即使本批无完整行），否则下一批的字节归属会错
    const newRemainderBytes = encodeUtf8Length(remainder)
    const carriedBytes = this.remainderBytes
    this.remainderBytes = newRemainderBytes

    if (n === 0) return []
    const cfg = this.clock?.()
    if (!cfg || cfg.domain !== 'wire') {
      // 到达域：首样本 = max(now, 上一采样 + 1)，批内逐行 +1ms 保单调
      const xs: number[] = []
      let x = Math.max(now, this.lastSampleX + 1)
      for (let s = 0; s < n; s++) {
        xs.push(x)
        x++
      }
      return xs
    }

    // wire 域：完整行消耗的字节 = 本批字节 + 上一批遗留的半截行字节 − 本批新留下的半截行字节
    // （跨批拼成的行要把上一批占用的字节补回来，否则该行的线缆时长被少算）。
    const payloadBytes = Math.max(0, byteCount + carriedBytes - newRemainderBytes)
    const bits = bitsPerByte(cfg.dataBits, cfg.parity, cfg.stopBits)
    const step = (payloadBytes * byteTimeMs(cfg.baudRate, bits)) / n
    return wireBatchXs(now, n, step, this.lastSampleX).xs
  }

  get labels(): readonly string[] {
    return this._labels
  }

  reset(): void {
    this.carryover = ''
    this.remainderBytes = 0
    this.labelIndex = new Map()
    this._labels = []
    this.lastSampleX = -Infinity
  }
}
