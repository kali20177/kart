import { describe, it, expect } from 'vitest'
import { computeChecksum, verifyChecksum, checksumByteLength, crc16modbus, crc32 } from './checksum'

// ── checksumByteLength ──

describe('checksumByteLength', () => {
  it('none → 0', () => { expect(checksumByteLength('none')).toBe(0) })
  it('sum8 → 1', () => { expect(checksumByteLength('sum8')).toBe(1) })
  it('xor8 → 1', () => { expect(checksumByteLength('xor8')).toBe(1) })
  it('crc16-modbus → 2', () => { expect(checksumByteLength('crc16-modbus')).toBe(2) })
  it('crc32 → 4', () => { expect(checksumByteLength('crc32')).toBe(4) })
})

// ── computeChecksum ──

describe('computeChecksum', () => {
  it('none returns empty', () => {
    expect(computeChecksum(new Uint8Array([1, 2, 3]), 'none')).toEqual(new Uint8Array(0))
  })

  it('sum8: [0x01, 0x02, 0x03] → 6', () => {
    expect(computeChecksum(new Uint8Array([1, 2, 3]), 'sum8')).toEqual(new Uint8Array([6]))
  })

  it('sum8: [0xFF, 0xFF] → 0xFE', () => {
    expect(computeChecksum(new Uint8Array([255, 255]), 'sum8')).toEqual(new Uint8Array([254]))
  })

  it('sum8: empty → 0', () => {
    expect(computeChecksum(new Uint8Array(0), 'sum8')).toEqual(new Uint8Array([0]))
  })

  it('xor8: [0x01, 0x02, 0x03] → 0', () => {
    expect(computeChecksum(new Uint8Array([1, 2, 3]), 'xor8')).toEqual(new Uint8Array([0]))
  })

  it('xor8: [0xFF, 0x00] → 0xFF', () => {
    expect(computeChecksum(new Uint8Array([255, 0]), 'xor8')).toEqual(new Uint8Array([255]))
  })

  it('xor8: empty → 0', () => {
    expect(computeChecksum(new Uint8Array(0), 'xor8')).toEqual(new Uint8Array([0]))
  })
})

// ── CRC16-Modbus ──

describe('crc16modbus', () => {
  it('standard check value: "123456789" → 0x4B37', () => {
    const data = new TextEncoder().encode('123456789')
    expect(crc16modbus(data)).toBe(0x4b37)
  })

  it('vector: 01 03 00 00 00 01 → 0x0A84', () => {
    const data = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01])
    expect(crc16modbus(data)).toBe(0x0a84)
  })

  it('vector: 01 04 00 01 00 01 → 0x0A60', () => {
    const data = new Uint8Array([0x01, 0x04, 0x00, 0x01, 0x00, 0x01])
    expect(crc16modbus(data)).toBe(0x0a60)
  })

  it('computeChecksum: output is LE bytes (low byte first)', () => {
    const data = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01])
    const cs = computeChecksum(data, 'crc16-modbus')
    // CRC reg = 0x0A84, LE = [0x84, 0x0A]
    expect(cs).toEqual(new Uint8Array([0x84, 0x0a]))
  })
})

// ── CRC32 (IEEE 802.3) ──

describe('crc32', () => {
  it('standard vector: "123456789" → 0xCBF43926', () => {
    const data = new TextEncoder().encode('123456789')
    expect(crc32(data)).toBe(0xcbf43926)
  })

  it('computeChecksum: output is LE bytes', () => {
    const data = new TextEncoder().encode('123456789')
    const cs = computeChecksum(data, 'crc32')
    // 0xCBF43926 LE = [0x26, 0x39, 0xF4, 0xCB]
    expect(cs).toEqual(new Uint8Array([0x26, 0x39, 0xf4, 0xcb]))
  })
})

// ── verifyChecksum ──

describe('verifyChecksum', () => {
  it('algo=none always ok', () => {
    const r = verifyChecksum(new Uint8Array([1, 2, 3]), 'none')
    expect(r.ok).toBe(true)
  })

  it('frame too short for crc16 → ok=true (skip)', () => {
    const r = verifyChecksum(new Uint8Array([0xaa]), 'crc16-modbus')
    expect(r.ok).toBe(true)
  })

  it('sum8: correct checksum → ok', () => {
    // payload=[1,2,3] sum=6 → frame=[1,2,3,6]
    const r = verifyChecksum(new Uint8Array([1, 2, 3, 6]), 'sum8')
    expect(r.ok).toBe(true)
  })

  it('sum8: wrong checksum → fail', () => {
    // payload=[1,2,3] sum=6 → frame=[1,2,3,7]
    const r = verifyChecksum(new Uint8Array([1, 2, 3, 7]), 'sum8')
    expect(r.ok).toBe(false)
    expect(r.expected).toBe(6)
    expect(r.got).toBe(7)
  })

  it('crc16-modbus: correct → ok', () => {
    // payload=[01,03,00,00,00,01] crc=0x0A84 LE→[84,0A]
    const frame = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01, 0x84, 0x0a])
    const r = verifyChecksum(frame, 'crc16-modbus')
    expect(r.ok).toBe(true)
  })

  it('crc16-modbus: wrong checksum → fail', () => {
    const frame = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x01, 0x84, 0x0b])
    const r = verifyChecksum(frame, 'crc16-modbus')
    expect(r.ok).toBe(false)
  })

  it('round-trip: computeVerify → ok', () => {
    for (const algo of ['sum8', 'xor8', 'crc16-modbus', 'crc32'] as const) {
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])
      const cs = computeChecksum(payload, algo)
      const frame = new Uint8Array(payload.length + cs.length)
      frame.set(payload)
      frame.set(cs, payload.length)
      const r = verifyChecksum(frame, algo)
      expect(r.ok).toBe(true)
    }
  })
})
