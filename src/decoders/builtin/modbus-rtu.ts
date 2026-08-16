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

/** Modbus 异常码名（响应 fc|0x80 时的数据字节） */
const EXCEPTION_CODES: Record<number, string> = {
  0x01: 'Illegal Function',
  0x02: 'Illegal Data Address',
  0x03: 'Illegal Data Value',
  0x04: 'Server Device Failure',
  0x05: 'Acknowledge',
  0x06: 'Server Device Busy',
  0x0a: 'Gateway Path Unavailable',
  0x0b: 'Gateway Target Device Failed to Respond'
}

function exceptionLabel(code: number): string {
  const name = EXCEPTION_CODES[code]
  return `0x${hex2(code)}${name ? ` ${name}` : ''}`
}

/** Modbus RTU 帧最小长度：addr+fc+data(≥1)+crc(2)=5。异常响应（fc|0x80）仅 5 字节，不能按请求帧的 8 字节卡 */
const MIN_LEN = 5

export const modbusRtuDecoder: DecoderDefinition = {
  id: 'modbus-rtu',
  name: 'Modbus RTU',
  description: 'Modbus RTU 帧解码（CRC16 校验通过才匹配）',
  // 匹配前提是帧尾 CRC16 校验通过（见 decode），声明自带校验——校验和弹窗据此提示
  // 用户避免设置不一致的接收校验算法（合法帧会被误标「校验失败」）。
  selfChecksIntegrity: true,
  integrityChecksum: 'crc16-modbus',
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
      { name: 'slave', value: `0x${hex2(addr)}`, offset: 0, length: 1, number: addr },
      { name: 'fc', value: fcLabel(fc), offset: 1, length: 1, number: fc },
    ]

    if (fc >= 0x80) {
      // 异常响应：fc|0x80 + 异常码（CRC 已在上方校验通过）
      const code = data.length > 0 ? data[0] : -1
      fields.push({
        name: 'exception',
        value: code >= 0 ? exceptionLabel(code) : '(无数据)',
        offset: dataStart,
        length: data.length,
        ...(code >= 0 ? { number: code } : {})
      })
    } else if (fc >= 0x01 && fc <= 0x04) {
      // 请求/响应判别：byteCount 一致性（data[0] === len-1）优先视为响应——
      // 合法 fc01/02 响应 byteCount 可为奇数（如 24 线圈→3 字节），先判请求会把 4 字节响应误判为请求；
      // fc03/04 寄存器响应 byteCount 恒为偶数（2 字节/寄存器），加偶数校验排除「起始地址高字节=3」的请求歧义。
      // 注：fc01/02 请求起始地址恰在 0x03xx 时仍存在歧义（同为 byteCount=3 的 4 字节），CRC 无法区分，属启发式取舍。
      const len = data.length
      const byteCount = data[0]
      const isResponse =
        len >= 2 && byteCount === len - 1 && (fc === 0x01 || fc === 0x02 || byteCount % 2 === 0)
      if (isResponse) {
        fields.push({ name: 'byteCount', value: String(byteCount), offset: dataStart, length: 1, number: byteCount })
        if (fc === 0x01 || fc === 0x02) {
          // 线圈/离散输入响应：位图字节（bit 位，非寄存器），按 hex 呈现
          fields.push({
            name: 'coils',
            value: bytesToHex(data.subarray(1)),
            offset: dataStart + 1,
            length: byteCount
          })
        } else {
          // 寄存器响应：u16 BE，同时输出数值数组（仪表盘按索引绑定第 N 个寄存器）
          const regs: string[] = []
          const regNums: number[] = []
          for (let i = 1; i + 1 < data.length; i += 2) {
            const v = (data[i] << 8) | data[i + 1]
            regs.push(`0x${hex4(v)}`)
            regNums.push(v)
          }
          fields.push({ name: 'registers', value: regs.join(', '), offset: dataStart + 1, length: byteCount, number: regNums })
        }
      } else if (len === 4) {
        // 请求帧：起始地址 + 数量
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2, number: count })
      } else if (len > 0) {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x05 || fc === 0x06) {
      // 写单线圈/单寄存器：起始地址 + 值（回显）
      if (data.length === 4) {
        const reg = (data[0] << 8) | data[1]
        const value = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'value', value: `0x${hex4(value)}`, offset: dataStart + 2, length: 2, number: value })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x0f || fc === 0x10) {
      // 写多线圈/多寄存器：起始地址 + 数量 + 数据
      if (data.length >= 5) {
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2, number: count })
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
