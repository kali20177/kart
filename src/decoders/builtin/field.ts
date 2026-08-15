// 内置「字段布局解析器」：按有序字段定义把帧切成带名字段。
// 字段 offset 省略 = 接续上一字段末尾；帧长不足任一字段或 header 不匹配 → 不匹配。

import type { DecodeField, DecoderDefinition, FieldDef, FieldDecoderOptions, FieldFormat } from '../types'
import { bytesToHex, parseHexInput } from '@/utils/hex'
import { decodeBytes } from '@/utils/encoding'

/** 各格式要求的最小字节数（DataView 越界会抛 RangeError，须前置校验） */
const FORMAT_MIN_LEN: Record<FieldFormat, number> = {
  u8: 1,
  u16le: 2,
  u16be: 2,
  u32le: 4,
  u32be: 4,
  ascii: 1,
  utf8: 1,
  hex: 1
}

/** 数值格式：长度必须与格式精确一致（超出会静默截断产生误导值）；ascii/utf8/hex 为变长，只需 ≥1 */
const NUMERIC_FORMATS: ReadonlySet<FieldFormat> = new Set(['u8', 'u16le', 'u16be', 'u32le', 'u32be'])

/** 读取一个字段的格式化显示值 */
function formatField(frame: Uint8Array, def: FieldDef, start: number): string {
  const slice = frame.subarray(start, start + def.length)
  switch (def.format) {
    case 'u8':
    case 'u16le':
    case 'u16be':
    case 'u32le':
    case 'u32be': {
      // subarray 与底层 buffer 共享，需带 byteOffset 构造 DataView
      const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
      switch (def.format) {
        case 'u8': return String(view.getUint8(0))
        case 'u16le': return String(view.getUint16(0, true))
        case 'u16be': return String(view.getUint16(0, false))
        case 'u32le': return String(view.getUint32(0, true))
        case 'u32be': return String(view.getUint32(0, false))
      }
      break
    }
    case 'ascii': return decodeBytes(slice, 'ascii')
    case 'utf8': return decodeBytes(slice, 'utf-8')
    case 'hex': return bytesToHex(slice)
    default:
      // 未知 format（持久化 JSON 可绕过 TS 联合）——decode 前置校验已拦截，此处兜底不渲染 undefined 脏值
      return ''
  }
}

/** 读取字段数值：仅数值格式有语义，返回 undefined 表示无数值（hex/ascii/utf8） */
function fieldNumber(frame: Uint8Array, def: FieldDef, start: number): number | undefined {
  if (!NUMERIC_FORMATS.has(def.format)) return undefined
  const slice = frame.subarray(start, start + def.length)
  // subarray 与底层 buffer 共享，需带 byteOffset 构造 DataView
  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
  switch (def.format) {
    case 'u8': return view.getUint8(0)
    case 'u16le': return view.getUint16(0, true)
    case 'u16be': return view.getUint16(0, false)
    case 'u32le': return view.getUint32(0, true)
    case 'u32be': return view.getUint32(0, false)
  }
}

/** header 前缀匹配：空/非法配置不拦截（宽容配置），否则要求 frame 以此开头 */
function matchesHeader(frame: Uint8Array, headerHex?: string): boolean {
  if (!headerHex) return true
  const r = parseHexInput(headerHex)
  if (!r.ok || r.bytes.length === 0) return true
  if (r.bytes.length > frame.length) return false
  for (let i = 0; i < r.bytes.length; i++) {
    if (frame[i] !== r.bytes[i]) return false
  }
  return true
}

export const fieldDecoder: DecoderDefinition<FieldDecoderOptions> = {
  id: 'field',
  name: '字段解析',
  description: '按字段布局（偏移/长度/格式）把帧解析为可命名渲染的字段',
  decode(frame, options) {
    const fields = options?.fields ?? []
    if (fields.length === 0) return { matched: false }
    if (!matchesHeader(frame, options?.header)) return { matched: false }
    const out: DecodeField[] = []
    let cursor = 0
    for (const def of fields) {
      const minLen = FORMAT_MIN_LEN[def.format]
      // 配置校验：缺名/长度 ≤0/未知格式（持久化 JSON 可绕过 TS）/长度不足——任一不满足即不匹配，
      // 避免渲染脏数据或 DataView 越界；数值格式长度须精确一致，超出会静默截断产生误导值
      if (!def || !def.name || minLen === undefined || def.length < minLen) return { matched: false }
      if (NUMERIC_FORMATS.has(def.format) && def.length !== minLen) return { matched: false }
      const start = def.offset ?? cursor
      if (start < 0 || start + def.length > frame.length) return { matched: false }
      const n = fieldNumber(frame, def, start)
      out.push({
        name: def.name,
        value: formatField(frame, def, start),
        offset: start,
        length: def.length,
        ...(n !== undefined ? { number: n } : {})
      })
      cursor = start + def.length
    }
    return { matched: true, fields: out }
  }
}
