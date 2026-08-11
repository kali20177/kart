// 内置 Modbus RTU 解码器：帧形 [addr][fc][data][crc16-LE]。
// CRC16（Modbus）校验通过且长度 ≥8 才匹配——坏帧保持原始视图，不渲染错误字段。

import type { DecodeField, DecoderDefinition } from '../types'
import { verifyChecksum } from '@/utils/checksum'
import { bytesToHex } from '@/utils/hex'

/** Modbus 标准功能码名（显示用，协议固定名不随 UI 语言变化） */
const FC_NAMES: Record<number, string> = {
  0x01: 'Read Coils',
  0x02: 'Read Discrete Inputs',
  0x03: 'Read Holding Registers',
  0x04: 'Read Input Registers',
  0x05: 'Write Single Coil',
  0x06: 'Write Single Register',
  0x08: 'Diagnostics',
  0x0f: 'Write Multiple Coils',
  0x10: 'Write Multiple Registers',
  0x11: 'Report Server ID',
  0x17: 'Read/Write Multiple Registers',
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase()
}
function hex4(n: number): string {
  return n.toString(16).padStart(4, '0').toUpperCase()
}

function fcLabel(fc: number): string {
  const name = FC_NAMES[fc]
  return `0x${hex2(fc)}${name ? ` ${name}` : ''}`
}

/** Modbus RTU 帧最小长度：addr+fc+4 数据+crc(2) */
const MIN_LEN = 8

export const modbusRtuDecoder: DecoderDefinition = {
  id: 'modbus-rtu',
  name: 'Modbus RTU',
  description: 'Modbus RTU 帧解码（CRC16 校验通过才匹配）',
  decode(frame) {
    if (frame.length < MIN_LEN) return { matched: false }
    // 帧尾 2 字节即 Modbus CRC16（小端），与接收校验语义一致
    const crc = verifyChecksum(frame, 'crc16-modbus')
    if (!crc.ok) return { matched: false }

    const addr = frame[0]
    const fc = frame[1]
    const data = frame.subarray(2, frame.length - 2)
    const crcBytes = frame.subarray(frame.length - 2)
    const dataStart = 2

    const fields: DecodeField[] = [
      { name: 'slave', value: `0x${hex2(addr)}`, offset: 0, length: 1 },
      { name: 'fc', value: fcLabel(fc), offset: 1, length: 1 },
    ]

    if (fc >= 0x01 && fc <= 0x04) {
      if (data.length === 4) {
        // 请求帧：起始地址 + 数量
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2 })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2 })
      } else if (data.length >= 5 && data[0] === data.length - 1) {
        // 响应帧：byteCount + 寄存器值（u16 BE）
        const byteCount = data[0]
        fields.push({ name: 'byteCount', value: String(byteCount), offset: dataStart, length: 1 })
        const regs: string[] = []
        for (let i = 1; i + 1 < data.length; i += 2) {
          regs.push(`0x${hex4((data[i] << 8) | data[i + 1])}`)
        }
        fields.push({ name: 'registers', value: regs.join(', '), offset: dataStart + 1, length: byteCount })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x05 || fc === 0x06) {
      // 写单线圈/单寄存器：起始地址 + 值（回显）
      if (data.length === 4) {
        const reg = (data[0] << 8) | data[1]
        const value = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2 })
        fields.push({ name: 'value', value: `0x${hex4(value)}`, offset: dataStart + 2, length: 2 })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x0f || fc === 0x10) {
      // 写多线圈/多寄存器：起始地址 + 数量 + 数据
      if (data.length >= 5) {
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2 })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2 })
        fields.push({ name: 'data', value: bytesToHex(data.subarray(4)), offset: dataStart + 4, length: data.length - 4 })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else {
      fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
    }

    fields.push({ name: 'crc', value: bytesToHex(crcBytes), offset: frame.length - 2, length: 2 })
    return { matched: true, fields, summary: `MB: slave=0x${hex2(addr)} fc=${fcLabel(fc)}` }
  }
}
