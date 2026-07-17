// 全局共享类型 —— 阶段 2 接入 Web Serial 时这些类型基本保持不变

/** 数据方向 */
export type Direction = 'rx' | 'tx'

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
  dataBits: 7 | 8
  stopBits: 1 | 2
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

/** 自定义快速命令 */
export interface QuickCommand {
  id: string
  name: string
  payload: string
  mode: DataMode
  /** 'inherit' 表示沿用发送框当前的行尾设置 */
  appendNewline: 'inherit' | LineEnding
  color?: string
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

/** 波形数值类型 —— 决定每采样字节数与 DataView 读取方法 */
export type NumericType =
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float32'
  | 'float64'

/** 波形解析配置：把连续字节流解析为多通道采样 */
export interface WaveformParseConfig {
  /** 数值类型（决定每采样字节数） */
  type: NumericType
  /** 大小端（uint8/int8 无效，仍保留以统一处理） */
  littleEndian: boolean
  /** 交错通道数 */
  channels: number
  /** 每 record 起始跳过的字节数（如帧头），连续流通常为 0 */
  byteOffset: number
}

/** 波形视图设置 */
export interface WaveformSettings {
  parse: WaveformParseConfig
  /** 采样率（Hz）—— 仅决定 X 轴时间刻度，不参与解析 */
  sampleRate: number
  /** 可视窗口点数（历史另保留至 MAX_HISTORY，暂停后可拖拽回看） */
  maxPoints: number
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
}

/** 模拟场景标识（阶段 1 专属） */
export type MockScenarioId =
  | 'silent'
  | 'at-reply'
  | 'binary-frames'
  | 'high-throughput'
  | 'mixed-ascii'
  | 'waveform'

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
