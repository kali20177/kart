import { describe, it, expect } from 'vitest'
import { sliceChunk, frameChunk, injectCorrupt } from './chunk-framer'
import { crc16modbus } from './checksum'

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join(' ')

describe('sliceChunk', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])

  it('按 chunkSize 切片，末包可短', () => {
    expect(hex(sliceChunk(bytes, 0, 3))).toBe('00 01 02')
    expect(hex(sliceChunk(bytes, 1, 3))).toBe('03 04 05')
    expect(hex(sliceChunk(bytes, 2, 3))).toBe('06 07') // 末包短包
  })

  it('chunkSize=0 表示整包一次下发', () => {
    expect(hex(sliceChunk(bytes, 0, 0))).toBe('00 01 02 03 04 05 06 07')
  })

  it('越界索引返回空', () => {
    expect(sliceChunk(bytes, 3, 3).length).toBe(0)
  })
})

describe('frameChunk', () => {
  const payload = new Uint8Array([0x01, 0x02, 0x03])

  it('raw：payload 原样', () => {
    expect(hex(frameChunk(payload, 0, 'raw', 'none'))).toBe('01 02 03')
  })

  it('len-prefix：头部 [lenLE16]', () => {
    expect(hex(frameChunk(payload, 0, 'len-prefix', 'none'))).toBe('03 00 01 02 03')
  })

  it('seq-crc：头部 [seqLE16][lenLE16] + payload + [crc16LE]', () => {
    const crc = crc16modbus(payload)
    const frame = frameChunk(payload, 5, 'seq-crc', 'none')
    expect(hex(frame)).toBe(`05 00 03 00 01 02 03 ${(crc & 0xff).toString(16).padStart(2, '0')} ${((crc >> 8) & 0xff).toString(16).padStart(2, '0')}`)
    // 尾部两字节即 payload 的 CRC16（小端）
    expect(frame[frame.length - 2] | (frame[frame.length - 1] << 8)).toBe(crc)
  })

  it('chunkSuffix 在封装后追加', () => {
    expect(hex(frameChunk(payload, 0, 'raw', 'crlf'))).toBe('01 02 03 0d 0a')
    expect(hex(frameChunk(payload, 0, 'len-prefix', 'lf'))).toBe('03 00 01 02 03 0a')
    expect(hex(frameChunk(payload, 0, 'raw', 'none'))).toBe('01 02 03')
  })
})

describe('injectCorrupt', () => {
  const wire = new Uint8Array([0xaa, 0x55, 0x01])

  it('everyN<=0 不注入', () => {
    expect(hex(injectCorrupt(wire, 3, 0))).toBe('aa 55 01')
  })

  it('chunkSeq=0 不注入（保证首包必然成功）', () => {
    expect(hex(injectCorrupt(wire, 0, 2))).toBe('aa 55 01')
  })

  it('每 N 包翻转末字节，且不修改原数组', () => {
    expect(hex(injectCorrupt(wire, 2, 2))).toBe('aa 55 fe')
    expect(hex(injectCorrupt(wire, 4, 2))).toBe('aa 55 fe')
    expect(hex(injectCorrupt(wire, 3, 2))).toBe('aa 55 01')
    expect(hex(wire)).toBe('aa 55 01') // 原数组不受影响
  })
})