import { describe, it, expect } from 'vitest'
import { modbusRtuDecoder } from './modbus-rtu'
import { modbusFrame } from '@/mock/scenarios'
import { crc16modbus } from '@/utils/checksum'

describe('modbus-rtu decoder', () => {
  it('fc03 读保持寄存器请求：slave/fc/reg/count', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x03, [0x00, 0x00, 0x00, 0x0a]))
    expect(r.matched).toBe(true)
    expect(r.fields?.map((f) => f.name)).toEqual(['slave', 'fc', 'reg', 'count', 'crc'])
    expect(r.fields?.[0]).toMatchObject({ name: 'slave', value: '0x01' })
    expect(r.fields?.[1].value).toContain('Read Holding')
    expect(r.fields?.find((f) => f.name === 'reg')?.value).toBe('0x0000')
    expect(r.fields?.find((f) => f.name === 'count')?.value).toBe('10')
    expect(r.summary).toContain('fc=0x03')
  })

  it('fc03 响应：byteCount + 寄存器值（u16 BE）', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x03, [0x04, 0x00, 0x64, 0x00, 0x01]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'byteCount')?.value).toBe('4')
    expect(r.fields?.find((f) => f.name === 'registers')?.value).toBe('0x0064, 0x0001')
  })

  it('fc06 写单寄存器：reg + value 回显', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x11, 0x06, [0x00, 0x01, 0x00, 0x03]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'reg')?.value).toBe('0x0001')
    expect(r.fields?.find((f) => f.name === 'value')?.value).toBe('0x0003')
  })

  it('fc10 写多寄存器：reg + count + data', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x10, [0x00, 0x00, 0x00, 0x02, 0x04, 0x00, 0x64, 0x00, 0x01]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'count')?.value).toBe('2')
    expect(r.fields?.find((f) => f.name === 'data')?.value).toBe('04 00 64 00 01')
  })

  it('标准 Modbus 测试向量：01 03 00 00 00 0A → CRC 0xCDC5', () => {
    // 广泛引用的标准示例（读取保持寄存器请求）：CRC16-Modbus = 0xCDC5，帧尾小端为 C5 CD
    expect(crc16modbus(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]))).toBe(0xcdc5)
    const frame = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a, 0xc5, 0xcd])
    expect(modbusRtuDecoder.decode(frame).matched).toBe(true)
  })

  it('fc01 线圈响应（byteCount=3 共 4 字节）→ 判为响应而非请求，按位图呈现', () => {
    // byteCount=3 + 3 位图字节，数据区恰好 4 字节——旧实现会误判为请求帧
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x01, [0x03, 0xcd, 0x6b, 0x05]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'byteCount')?.value).toBe('3')
    expect(r.fields?.find((f) => f.name === 'coils')?.value).toBe('CD 6B 05')
    expect(r.fields?.find((f) => f.name === 'reg')).toBeUndefined()
  })

  it('fc01 请求（起始 0x0000 数量 0x0A）→ 判为请求', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x01, [0x00, 0x00, 0x00, 0x0a]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'reg')?.value).toBe('0x0000')
    expect(r.fields?.find((f) => f.name === 'count')?.value).toBe('10')
  })

  it('fc03 请求起始地址 0x0300（byteCount 奇数歧义）→ 偶数校验排除，判为请求', () => {
    // 请求 data=[0x03,0x00,0x00,0x0A]：data[0]===3 满足 len-1，但 byteCount 奇数为非法 fc03 响应 → 走请求分支
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x03, [0x03, 0x00, 0x00, 0x0a]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'reg')?.value).toBe('0x0300')
    expect(r.fields?.find((f) => f.name === 'count')?.value).toBe('10')
  })

  it('异常响应（fc|0x80）→ 解析异常码', () => {
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x83, [0x02]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'fc')?.value).toContain('0x83')
    expect(r.fields?.find((f) => f.name === 'exception')?.value).toBe('0x02 Illegal Data Address')
  })

  it('byteCount 与数据长度不符 → 不判响应，回退 data 字段', () => {
    // byteCount=4 但只有 2 个数据字节：4 !== 2 → 非响应、非请求 → data hex
    const r = modbusRtuDecoder.decode(modbusFrame(0x01, 0x03, [0x04, 0x00, 0x64]))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'data')?.value).toBe('04 00 64')
  })

  it('CRC 损坏 → 不匹配（坏帧保持原始视图）', () => {
    const frame = modbusFrame(0x01, 0x03, [0x00, 0x00, 0x00, 0x0a])
    frame[frame.length - 1] ^= 0xff
    expect(modbusRtuDecoder.decode(frame).matched).toBe(false)
  })

  it('帧过短（<5）→ 不匹配', () => {
    expect(modbusRtuDecoder.decode(new Uint8Array([0x01, 0x03, 0x00, 0x00])).matched).toBe(false)
  })
})
