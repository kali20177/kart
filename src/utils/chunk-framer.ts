// 文件下发的分包协议封装（纯逻辑，可单测）：
// 切片 + framing（raw / len-prefix / seq-crc）+ 行尾 + 错误注入。
// 与 rate-limit / ack 组合成引擎的纯逻辑层，store 只做调度。

import type { ChunkFraming, LineEnding } from '@/types'
import { crc16modbus } from './checksum'

/** 切片 —— chunkSize=0 表示整包一次下发；末包可短。 */
export function sliceChunk(bytes: Uint8Array, chunkIndex: number, chunkSize: number): Uint8Array {
  const size = chunkSize > 0 ? chunkSize : bytes.length
  const start = chunkIndex * size
  if (start >= bytes.length) return new Uint8Array(0)
  return bytes.slice(start, Math.min(start + size, bytes.length))
}

const SUFFIX_BYTES: Record<LineEnding, Uint8Array> = {
  none: new Uint8Array(0),
  cr: new Uint8Array([0x0d]),
  lf: new Uint8Array([0x0a]),
  crlf: new Uint8Array([0x0d, 0x0a])
}

/**
 * 按 framing 封装一个切片为线字节：
 *   raw         → payload
 *   len-prefix  → [lenLE16] + payload
 *   seq-crc     → [seqLE16][lenLE16] + payload + [crc16LE]（crc 对 payload 计算）
 * chunkSuffix 在封装后追加（设备按行缓冲时用）。
 */
export function frameChunk(
  chunk: Uint8Array,
  seq: number,
  framing: ChunkFraming,
  chunkSuffix: LineEnding
): Uint8Array {
  let wire: Uint8Array

  switch (framing) {
    case 'len-prefix': {
      const len = chunk.length
      const header = new Uint8Array([len & 0xff, (len >> 8) & 0xff])
      wire = new Uint8Array(header.length + chunk.length)
      wire.set(header)
      wire.set(chunk, header.length)
      break
    }
    case 'seq-crc': {
      const len = chunk.length
      const crcVal = crc16modbus(chunk)
      const header = new Uint8Array([
        seq & 0xff, (seq >> 8) & 0xff,
        len & 0xff, (len >> 8) & 0xff
      ])
      const footer = new Uint8Array([crcVal & 0xff, (crcVal >> 8) & 0xff])
      wire = new Uint8Array(header.length + chunk.length + footer.length)
      wire.set(header)
      wire.set(chunk, header.length)
      wire.set(footer, header.length + chunk.length)
      break
    }
    default: // raw
      wire = new Uint8Array(chunk)
      break
  }

  const suffix = SUFFIX_BYTES[chunkSuffix]
  if (suffix.length > 0) {
    const combined = new Uint8Array(wire.length + suffix.length)
    combined.set(wire)
    combined.set(suffix, wire.length)
    wire = combined
  }

  return wire
}

/**
 * 错误注入：每 everyN 包把最后一个字节翻转（破坏 CRC，触发设备 NACK → 验证重试路径）。
 * everyN<=0 或 chunkSeq 为 0（首包不注入，保证首包必然成功）时不注入。
 */
export function injectCorrupt(wire: Uint8Array, chunkSeq: number, everyN: number): Uint8Array {
  if (everyN > 0 && chunkSeq > 0 && chunkSeq % everyN === 0 && wire.length > 0) {
    const corrupted = new Uint8Array(wire)
    corrupted[corrupted.length - 1] ^= 0xff
    return corrupted
  }
  return wire
}