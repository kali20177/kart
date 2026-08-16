// 解码器注册表契约 —— 把「帧 → 结构化字段视图」的解析做成可注册扩展点。
// 本阶段仅内置 TS 解码器；将来 JS 脚本解码器（CSP 禁 eval，需 vm/worker 沙箱）可复用同一契约。

import type { ChecksumAlgorithm } from '@/types'

/** 一个已解码的字段：名称 + 已格式化的显示值 + 在帧中的位置 */
export interface DecodeField {
  name: string
  /** 已按 format 格式化好的显示值 */
  value: string
  /** 在（剥离帧尾分隔符后的）载荷帧中的起始字节偏移 */
  offset: number
  /** 字段字节长度 */
  length: number
  /**
   * 数值型字段的原始数值（供仪表盘等数值消费方，无需再回解字节）。
   * 标量字段为 number；多值字段（如 Modbus 寄存器组）为 number[]，按序号对应 value 中的值。
   * 无数值语义的字段（hex/ascii/utf8 等）省略。
   */
  number?: number | number[]
}

/** 解码结果：matched=false 表示本帧不适用该解码器（保持原始帧显示） */
export interface DecodeResult {
  matched: boolean
  fields?: DecodeField[]
  /** 概要行（如 "MB: fc=03 Read Holding Registers"），渲染在字段块首行 */
  summary?: string
}

/** 解码器定义：注册表项。id 唯一，decode 为纯函数（无状态、可单测）。 */
export interface DecoderDefinition<O = unknown> {
  id: string
  /** 显示名（内置集用协议名，与 themes 同例：registry 层保持纯数据） */
  name: string
  description?: string
  /**
   * 解码器自带帧完整性校验（匹配成功即意味着帧校验通过，如 Modbus RTU 内部验证 CRC16）。
   * 校验和弹窗据此提示用户：接收校验算法与 integrityChecksum 不一致时，合法帧也会被
   * 标记为校验失败。数据驱动护栏——未来新增自带校验的解码器只需声明此字段，调用端无需改动。
   */
  selfChecksIntegrity?: boolean
  /** selfChecksIntegrity 所用的校验算法（冲突提示文案用；声明 selfChecksIntegrity 时应同时声明） */
  integrityChecksum?: ChecksumAlgorithm
  /** 帧（已剥离帧尾分隔符）→ 字段视图；options 由各解码器解释，可省略 */
  decode(frame: Uint8Array, options?: O): DecodeResult
}

/** 挂在 Message 上的解码信息（气泡渲染用） */
export interface DecodeInfo {
  decoderId: string
  summary?: string
  fields: DecodeField[]
}

/** 会话级解码器配置（按端口持久化，见 session/index.ts） */
export interface DecoderConfig {
  /** 注册表 id（如 'field' / 'modbus-rtu'）；空串 = 不启用解码 */
  id: string
  /** 解码器专属选项（JSON 可持久化，类型由各解码器解释） */
  options: Record<string, unknown>
}

// ── 内置「字段布局解析器」的配置 ──

export type FieldFormat =
  | 'u8'
  | 'u16le'
  | 'u16be'
  | 'u32le'
  | 'u32be'
  | 'ascii'
  | 'utf8'
  | 'hex'

export interface FieldDef {
  /** 字段名（渲染标签） */
  name: string
  /** 起始字节偏移；省略 = 接续上一字段末尾（首个省略 = 0） */
  offset?: number
  /** 字节长度 */
  length: number
  /** 显示格式 */
  format: FieldFormat
}

export interface FieldDecoderOptions {
  /** 有序字段布局 */
  fields: FieldDef[]
  /** 可选帧头匹配（hex 字符串，如 "AA55"），提升匹配精度；空/非法配置不限制 */
  header?: string
}
