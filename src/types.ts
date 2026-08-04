// 全局共享类型 —— 阶段 2 接入 Web Serial 时这些类型基本保持不变

/** 数据方向 */
export type Direction = 'rx' | 'tx'

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 显示 / 输入模式 */
export type DataMode = 'ascii' | 'hex'

/** 字符编码（用于 ASCII 视图解码） */
export type Encoding = 'utf-8' | 'ascii' | 'gbk'

/** 发送时追加的行尾符 */
export type LineEnding = 'none' | 'cr' | 'lf' | 'crlf'

/** 一条消息（一帧）。原始数据始终以字节保存，视图按需格式化 */
export interface Message {
  id: number
  direction: Direction
  /** 原始字节 —— ASCII / HEX 视图都从这里即时格式化，切换视图不重建数据 */
  bytes: Uint8Array
  /** 毫秒时间戳（Date.now()） */
  timestamp: number
  /** 可选错误标记（如发送失败、解码替换） */
  error?: string
  /** 校验失败标记（与 error 独立，可共存） */
  checksumFailed?: boolean
  /** 消息种类：'frame'=普通帧，'file'=文件下发气泡，'divider'=分隔线（缺省 'frame' 向后兼容） */
  kind?: 'frame' | 'file' | 'divider'
  /** 文件下发时指向 transfer store 中的状态 */
  transferId?: string
  /** 用户标注文本：附在帧数据上的注释（仅 kind='frame' 有意义）；分隔线用作标签文本 */
  note?: string
}

/** 串口连接参数 */
export interface PortOptions {
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 1.5 | 2
  parity: 'none' | 'even' | 'odd'
  flowControl: 'none' | 'hardware'
}

/** 用户自定义波特率项（可带标注；预设档位不在此列、不可删除） */
export interface CustomBaudRate {
  baud: number
  note?: string
}

/** 控制线状态（阶段 1 来自 Mock，阶段 2 来自 port.getSignals()） */
export interface SerialSignals {
  dcd: boolean
  cts: boolean
  dsr: boolean
  ri: boolean
}

/**
 * 串口枚举项。各驱动尽力填充元数据：
 * - serialport：path/manufacturer/vendorId/productId 均有
 * - Web Serial：path + vendorId/productId（厂商名按 VID 反查 usb-vendors 表，查不到则无）
 * - mock：造假的完整元数据用于开发预览
 */
export interface PortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

/**
 * 串口驱动接口 —— Mock 与未来的 Web Serial 实现共享这一契约。
 * 阶段 2 只需写一个实现该接口的 WebSerialDriver，serial store 不动。
 */
export interface SerialDriver {
  listPorts(): Promise<PortInfo[]>
  /** 触发浏览器串口选择器（Web Serial 专属），返回新端口标识；用户取消返回 null */
  requestPort?(): Promise<string | null>
  open(path: string, options: PortOptions): Promise<void>
  close(): Promise<void>
  write(bytes: Uint8Array): Promise<void>
  getSignals(): SerialSignals
  /** 订阅接收数据，返回取消订阅函数 */
  onData(cb: (bytes: Uint8Array) => void): () => void
  readonly isOpen: boolean
}

/** 校验和算法标识 */
export type ChecksumAlgorithm = 'none' | 'sum8' | 'xor8' | 'crc16-modbus' | 'crc32'

/** 自定义快速命令 */
export interface QuickCommand {
  id: string
  name: string
  payload: string
  mode: DataMode
  /** 'inherit' 表示沿用发送框当前的行尾设置 */
  appendNewline: 'inherit' | LineEnding
  color?: string
  /** 校验和算法，'inherit' 使用全局设置 */
  checksum?: 'inherit' | ChecksumAlgorithm
}

/** 帧切分策略 */
export type FrameStrategy = 'gap-timeout' | 'delimiter' | 'fixed-length'

/** 帧切分配置 */
export interface FrameConfig {
  strategy: FrameStrategy
  /** gap-timeout：空闲多少毫秒判定为一帧结束 */
  gapMs: number
  /** delimiter：分隔符（hex 字符串，如 "0D0A"） */
  delimiterHex: string
  /** fixed-length：每帧字节数 */
  fixedLength: number
}

/** 波形解析配置：把连续字节流解析为多通道采样。
 *
 * 当前仅实现文本行解析（Arduino Serial.println 风格），通道数由数据内容自动检测：
 * - 无标签数值行（如 `1,2\n`）：按 token 数量自动扩容
 * - 标签化行（如 `Sin:0.5,Cos:0.86\n`）：按标签名自动分配通道
 *
 * 未来扩展新协议时：在此新增协议标识及专属配置字段，
 * 并在 waveform store 中按协议分发到对应 WaveformParser 实现类。 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WaveformParseConfig {

}

/** 波形视图设置 */
export interface WaveformSettings {
  parse: WaveformParseConfig
  /** 可视窗口点数（运行中显示的最新采样数，满后转滑动窗口） */
  maxPoints: number
  /** 历史缓冲上限（采样数）；≥ maxPoints，暂停后可拖拽回看的总量 */
  maxHistoryPoints: number
}

/** 导出偏好（持久化到 localStorage） */
export interface ExportPreferences {
  format: 'txt' | 'csv' | 'json' | 'binary'
  direction: 'all' | 'rx' | 'tx'
  dataMode: DataMode
  timeStyle: 'full' | 'short' | 'none'
  showFrameNum: boolean
  showDelta: boolean
  showByteCount: boolean
  showElapsed: boolean
  showError: boolean
  includeDividers: boolean
  includeNotes: boolean
}

/** 全局设置 */
export interface AppSettings {
  // 接收
  encoding: Encoding
  frame: FrameConfig
  bufferLimit: number
  // 显示
  defaultView: DataMode
  // 主题
  themeId: string
  fontSize: number
  locale: 'zh-CN' | 'en-US'
  // 波形
  waveform: WaveformSettings
  // 连接
  autoReconnect: boolean
  // 暂停
  /** 恢复时是否 toast 提示缺失数据时间段 */
  showPauseNotification: boolean
  // 录制
  recordFormat: RecordFormat
  // 校验和
  /** 发送侧追加的校验和算法（全局默认，快速命令可 inherit 此值或覆盖） */
  sendChecksum: ChecksumAlgorithm
  /** 接收侧使用的校验和算法；'none' 即关闭接收校验，无需独立开关 */
  rxChecksumAlgorithm: ChecksumAlgorithm
}

/** 模拟场景标识（阶段 1 专属） */
export type MockScenarioId =
  | 'silent'
  | 'at-reply'
  | 'binary-frames'
  | 'high-throughput'
  | 'mixed-ascii'
  | 'waveform-text'
  | 'waveform-text-labeled'

// ─── 文件下发类型（阶段 1 文件传输 UI） ───

/** 文件下发状态机 */
export type TransferStatus =
  | 'queued'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'aborted'
  | 'error'

/** 分包协议封装 */
export type ChunkFraming =
  | 'raw'         // 裸字节
  | 'len-prefix'  // [lenLE16] + payload
  | 'seq-crc'     // [seqLE16][lenLE16] + payload + [crc16LE]

/** ACK 匹配策略 */
export type AckMode = 'any' | 'byte' | 'echo-crc'

/** 文件下发配置 */
export interface FileTransferConfig {
  chunkSize: number        // 0 = 不分包，整包下发
  interChunkDelay: number  // 包间延时 ms
  bytesPerSecond: number   // 字节速率上限 B/s（0 = 不限）
  retries: number          // 单包失败重试次数
  framing: ChunkFraming
  chunkSuffix: LineEnding  // 封装后是否追加行尾
  waitForAck: boolean
  ackMode: AckMode
  ackByte: number          // ACK 字节，默认 0x06
  ackTimeout: number       // ACK 超时 ms
  startOffset: number      // 断点续传起始偏移
  repeat: number           // 循环次数（0=单次）
  logEachChunk: boolean    // 调试：每包另起一条 TX 帧气泡
  injectCorruptEveryN: number  // 0=off；每 N 包破坏 CRC
  injectSkipAckEveryN: number  // 0=off；每 N 包忽略 ACK
}

/** 录制输出格式 */
export type RecordFormat = 'text' | 'csv'

/** 录制器状态机 */
export type RecordStatus = 'idle' | 'recording' | 'stopping' | 'error'

/** 录制配置 */
export interface RecordConfig {
  format: RecordFormat
}

/** 录制运行时状态（StatusBar 读取，shallowRef 范式） */
export interface RecordState {
  status: RecordStatus
  fileName: string
  fileSize: number
  startedAt: number
  byteCount: number
  error?: string
}

/** 预设标识 */
export type TransferPresetId =
  | 'raw'          // 原始整包下发
  | 'stm32-isp'    // STM32 ISP (256B·ACK)
  | 'esp32'        // ESP32 (4KB·ACK)
  | 'stress'       // 鲁棒性压测(循环)
  | 'custom'       // 自定义

/** 一次下发的运行时状态 */
export interface FileTransferState {
  id: string
  filename: string
  size: number
  status: TransferStatus
  sent: number             // 已（确认）下发字节
  total: number            // 文件总字节
  currentChunk: number
  totalChunks: number
  pass: number             // 当前循环轮次
  startedAt: number
  elapsedMs: number
  bytesPerSec: number      // 平滑后的实时速率
  failedChunk?: number     // 失败包号
  error?: string
}
