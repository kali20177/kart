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
}

/** 串口连接参数 */
export interface PortOptions {
  baudRate: number
  dataBits: 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd'
  flowControl: 'none' | 'hardware'
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

/** 主题 */
export type ThemeMode = 'light' | 'dark' | 'system'

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
  /** 滑动窗口最大点数，超出从头裁剪 */
  maxPoints: number
}

/** 全局设置 */
export interface AppSettings {
  // 接收
  encoding: Encoding
  frame: FrameConfig
  bufferLimit: number
  // 显示
  defaultView: DataMode
  theme: ThemeMode
  fontSize: number
  // 波形
  waveform: WaveformSettings
  // 连接
  autoReconnect: boolean
}

/** 模拟场景标识（阶段 1 专属） */
export type MockScenarioId =
  | 'silent'
  | 'at-reply'
  | 'binary-frames'
  | 'high-throughput'
  | 'mixed-ascii'
  | 'waveform'
