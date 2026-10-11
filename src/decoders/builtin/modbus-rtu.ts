// 内置 Modbus RTU 解码器：帧形 [addr][fc][data][crc16-LE]。
// CRC16（Modbus）校验通过且长度 ≥8 才匹配——坏帧保持原始视图，不渲染错误字段。

import type { DecodeField, DecoderDefinition } from '@/decoders/types'
import { verifyChecksum } from '@/utils/codec/checksum'
import { bytesToHex } from '@/utils/codec/hex'

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
  0x16: 'Mask Write Register',
  0x17: 'Read/Write Multiple Registers',
  0x2b: 'Encapsulated Interface Transport',
}

/** FC08 诊断子功能名（Modbus V1.1b3；未列出的子功能按 hex 呈现） */
const FC08_SUBFN_NAMES: Record<number, string> = {
  0x0000: 'Return Query Data',
  0x0002: 'Return Diagnostic Register',
  0x000a: 'Clear Counters and Diagnostic Register',
  0x000b: 'Return Bus Message Count',
  0x000c: 'Return Bus Communication Error Count',
  0x000d: 'Return Bus Exception Error Count',
  0x000e: 'Return Slave Message Count',
}

/** FC43/0x0E 设备识别的 MEI 类型名 */
const MEI_NAMES: Record<number, string> = {
  0x0d: 'CANopen Reference',
  0x0e: 'Device Identification',
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

/**
 * FC43/0x0E 设备识别响应的对象区解析：从 data[6] 起重复 [id(1) len(1) bytes]。
 * 任何截断/越界都返回 null，调用方退回裸 data——识别对象的 ASCII 值不可信时宁可不渲染。
 */
function parseDeviceIdObjects(data: Uint8Array): string[] | null {
  const objects: string[] = []
  let i = 6
  while (i < data.length) {
    if (i + 2 > data.length) return null
    const id = data[i]
    const len = data[i + 1]
    if (i + 2 + len > data.length) return null
    let text = ''
    for (let j = 0; j < len; j++) {
      const b = data[i + 2 + j]
      text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'
    }
    objects.push(`0x${hex2(id)} "${text}"`)
    i += 2 + len
  }
  return objects
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
      // 写多线圈/多寄存器。请求携带 byteCount（addr+qty+byteCount+data），成功应答是
      // addr+qty 的回显——4 字节数据段无歧义地是应答，≥5 字节必然是请求。
      if (data.length === 4) {
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2, number: count })
      } else if (data.length >= 5) {
        const reg = (data[0] << 8) | data[1]
        const count = (data[2] << 8) | data[3]
        const byteCount = data[4]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'count', value: String(count), offset: dataStart + 2, length: 2, number: count })
        fields.push({ name: 'byteCount', value: String(byteCount), offset: dataStart + 4, length: 1, number: byteCount })
        fields.push({ name: 'data', value: bytesToHex(data.subarray(5)), offset: dataStart + 5, length: data.length - 5 })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x08) {
      // 诊断：子功能 + data；应答是请求的回显（形状相同，无需判别）
      if (data.length >= 2) {
        const sub = (data[0] << 8) | data[1]
        const name = FC08_SUBFN_NAMES[sub]
        fields.push({
          name: 'subfn',
          value: `0x${hex4(sub)}${name ? ` ${name}` : ''}`,
          offset: dataStart,
          length: 2,
          number: sub
        })
        fields.push({ name: 'data', value: bytesToHex(data.subarray(2)), offset: dataStart + 2, length: data.length - 2 })
        // 计数器类子功能的 data 即 u16 BE 计数值
        if (sub >= 0x0b && sub <= 0x0e && data.length >= 4) {
          const n = (data[2] << 8) | data[3]
          fields.push({ name: 'count', value: String(n), offset: dataStart + 2, length: 2, number: n })
        }
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x16) {
      // 掩码写：参考地址 + AND 掩码 + OR 掩码；应答是请求的回显（形状相同，无需判别）
      if (data.length === 6) {
        const reg = (data[0] << 8) | data[1]
        const and = (data[2] << 8) | data[3]
        const or = (data[4] << 8) | data[5]
        fields.push({ name: 'reg', value: `0x${hex4(reg)}`, offset: dataStart, length: 2, number: reg })
        fields.push({ name: 'andMask', value: `0x${hex4(and)}`, offset: dataStart + 2, length: 2, number: and })
        fields.push({ name: 'orMask', value: `0x${hex4(or)}`, offset: dataStart + 4, length: 2, number: or })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: data.length })
      }
    } else if (fc === 0x17) {
      // 读写多寄存器。判别同 FC03/04：响应 byteCount 恒为偶数且 = len-1；请求首字节是
      // 读起始地址高字节，恰与响应 byteCount 同值同偶时仍不可分（本表地址 ≤ 0x15，到不了）。
      const len = data.length
      const byteCount = data[0]
      const isResponse = len >= 2 && byteCount === len - 1 && byteCount % 2 === 0
      if (isResponse) {
        fields.push({ name: 'byteCount', value: String(byteCount), offset: dataStart, length: 1, number: byteCount })
        const regs: string[] = []
        const regNums: number[] = []
        for (let i = 1; i + 1 < data.length; i += 2) {
          const v = (data[i] << 8) | data[i + 1]
          regs.push(`0x${hex4(v)}`)
          regNums.push(v)
        }
        fields.push({ name: 'registers', value: regs.join(', '), offset: dataStart + 1, length: byteCount, number: regNums })
      } else if (len >= 9) {
        // 请求：读起始+数量 + 写起始+数量 + byteCount + 写数据
        const readReg = (data[0] << 8) | data[1]
        const readQty = (data[2] << 8) | data[3]
        const writeReg = (data[4] << 8) | data[5]
        const writeQty = (data[6] << 8) | data[7]
        fields.push({ name: 'readReg', value: `0x${hex4(readReg)}`, offset: dataStart, length: 2, number: readReg })
        fields.push({ name: 'readCount', value: String(readQty), offset: dataStart + 2, length: 2, number: readQty })
        fields.push({ name: 'writeReg', value: `0x${hex4(writeReg)}`, offset: dataStart + 4, length: 2, number: writeReg })
        fields.push({ name: 'writeCount', value: String(writeQty), offset: dataStart + 6, length: 2, number: writeQty })
        fields.push({ name: 'byteCount', value: String(data[8]), offset: dataStart + 8, length: 1, number: data[8] })
        fields.push({ name: 'data', value: bytesToHex(data.subarray(9)), offset: dataStart + 9, length: len - 9 })
      } else {
        fields.push({ name: 'data', value: bytesToHex(data), offset: dataStart, length: len })
      }
    } else if (fc === 0x2b) {
      // 封装接口传输（MEI）：0x0E = 设备识别。请求 3 字节（code+objectId），
      // 响应 ≥6 字节（code+conformity+more+next+count+对象区）
      if (data.length > 0) {
        const mei = data[0]
        const meiName = MEI_NAMES[mei]
        fields.push({
          name: 'meiType',
          value: `0x${hex2(mei)}${meiName ? ` ${meiName}` : ''}`,
          offset: dataStart,
          length: 1,
          number: mei
        })
        if (mei === 0x0e && data.length === 3) {
          fields.push({ name: 'deviceIdCode', value: String(data[1]), offset: dataStart + 1, length: 1, number: data[1] })
          fields.push({ name: 'objectId', value: `0x${hex2(data[2])}`, offset: dataStart + 2, length: 1, number: data[2] })
        } else if (mei === 0x0e && data.length >= 6) {
          fields.push({ name: 'deviceIdCode', value: String(data[1]), offset: dataStart + 1, length: 1, number: data[1] })
          fields.push({ name: 'conformity', value: `0x${hex2(data[2])}`, offset: dataStart + 2, length: 1, number: data[2] })
          fields.push({ name: 'moreFollows', value: String(data[3]), offset: dataStart + 3, length: 1, number: data[3] })
          fields.push({ name: 'objectCount', value: String(data[5]), offset: dataStart + 5, length: 1, number: data[5] })
          const objects = parseDeviceIdObjects(data)
          if (objects) {
            fields.push({
              name: 'deviceId',
              value: objects.join(', '),
              offset: dataStart + 6,
              length: data.length - 6
            })
          } else {
            fields.push({ name: 'data', value: bytesToHex(data.subarray(6)), offset: dataStart + 6, length: data.length - 6 })
          }
        } else {
          fields.push({ name: 'data', value: bytesToHex(data.subarray(1)), offset: dataStart + 1, length: data.length - 1 })
        }
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
