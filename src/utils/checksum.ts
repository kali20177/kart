// 校验和算法：嵌入式协议常用的完整性校验

export type ChecksumAlgorithm = 'none' | 'sum8' | 'xor8' | 'crc16-modbus' | 'crc32'

/** 算法对应的校验和字节数 */
export function checksumByteLength(algo: ChecksumAlgorithm): number {
  switch (algo) {
    case 'none':          return 0
    case 'sum8':          return 1
    case 'xor8':          return 1
    case 'crc16-modbus':  return 2
    case 'crc32':         return 4
  }
}

/** 计算 data 的校验和，返回小端字节数组 */
export function computeChecksum(data: Uint8Array, algo: ChecksumAlgorithm): Uint8Array {
  switch (algo) {
    case 'none': return new Uint8Array(0)
    case 'sum8': {
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      return new Uint8Array([sum & 0xff])
    }
    case 'xor8': {
      let xor = 0
      for (let i = 0; i < data.length; i++) xor ^= data[i]
      return new Uint8Array([xor])
    }
    case 'crc16-modbus': {
      return crc16modbusBytes(data)
    }
    case 'crc32': {
      return crc32Bytes(data)
    }
  }
}

/**
 * 验证帧尾校验和。
 * data 末尾 byteLen 字节为校验和，前半部分为载荷。
 * 帧太短或 algo='none' 时返回 ok=true 跳过校验。
 */
export function verifyChecksum(
  data: Uint8Array,
  algo: ChecksumAlgorithm
): { ok: boolean; expected: number; got: number } {
  if (algo === 'none') return { ok: true, expected: 0, got: 0 }
  const n = checksumByteLength(algo)
  if (data.length <= n) return { ok: true, expected: 0, got: 0 }

  const payload = data.subarray(0, data.length - n)
  const expected = computeChecksum(payload, algo)

  // 从帧尾读取校验和字节拼成数字（小端）
  let got = 0
  for (let i = 0; i < n; i++) {
    got |= data[data.length - n + i] << (i * 8)
  }

  // 比较
  let expectedVal = 0
  for (let i = 0; i < expected.length; i++) {
    expectedVal |= expected[i] << (i * 8)
  }

  return { ok: got === expectedVal, expected: expectedVal, got }
}

// ── CRC16-Modbus (poly=0x8005, init=0xffff, refIn/refOut=true, xorOut=0x0000) ──

export function crc16modbus(data: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xa001
      } else {
        crc >>= 1
      }
    }
  }
  return crc
}

function crc16modbusBytes(data: Uint8Array): Uint8Array {
  const val = crc16modbus(data)
  return new Uint8Array([val & 0xff, (val >> 8) & 0xff])
}

// ── CRC32 (IEEE 802.3: poly=0x04C11DB7 反转=0xEDB88320, init=0xFFFFFFFF, xorOut=0xFFFFFFFF) ──

const CRC32_TABLE: Int32Array = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c = (c >>> 1) ^ 0xedb88320
      } else {
        c = c >>> 1
      }
    }
    table[i] = c
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function crc32Bytes(data: Uint8Array): Uint8Array {
  const val = crc32(data)
  return new Uint8Array([val & 0xff, (val >> 8) & 0xff, (val >> 16) & 0xff, (val >> 24) & 0xff])
}
