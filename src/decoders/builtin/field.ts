// 内置「字段布局解析器」：按有序字段定义把帧切成带名字段。
// 字段 offset 省略 = 接续上一字段末尾；帧长不足任一字段或 header 不匹配 → 不匹配。

import type { DecodeField, DecoderDefinition, FieldDef, FieldDecoderOptions } from '../types'
import { bytesToHex, parseHexInput } from '@/utils/hex'
import { decodeBytes } from '@/utils/encoding'

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
      // 非法字段定义（缺名/长度 ≤0）视为配置错误 → 不匹配，避免渲染脏数据
      if (!def || !def.name || def.length <= 0) return { matched: false }
      const start = def.offset ?? cursor
      if (start < 0 || start + def.length > frame.length) return { matched: false }
      out.push({ name: def.name, value: formatField(frame, def, start), offset: start, length: def.length })
      cursor = start + def.length
    }
    return { matched: true, fields: out }
  }
}
