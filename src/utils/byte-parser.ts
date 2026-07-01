import type { NumericType, WaveformParseConfig } from '@/types'

/**
 * 字节流 → 多通道采样数值的纯函数解析器。
 *
 * 设计为无状态纯函数：调用方持有 carryover（上批的零头），跨回调承接半截采样。
 * 不依赖 Vue，可独立单测。阶段 2 接真实串口时同一套配置复用。
 *
 * 一个 record = [byteOffset 跳过字节][channels 个交错采样]。
 * 例：int16 LE、2 通道、byteOffset=0 → 每 4 字节出一组 [ch0, ch1]。
 */

/** 每种数值类型占用的字节数 */
export function bytesPerSample(type: NumericType): number {
  switch (type) {
    case 'uint8':
    case 'int8':
      return 1
    case 'uint16':
    case 'int16':
      return 2
    case 'uint32':
    case 'int32':
    case 'float32':
      return 4
    case 'float64':
      return 8
  }
}

/** 单个 record 的字节数 = 偏移 + 通道数 × 每采样字节数 */
export function recordSize(cfg: WaveformParseConfig): number {
  return Math.max(0, cfg.byteOffset) + Math.max(1, cfg.channels) * bytesPerSample(cfg.type)
}

interface ParseResult {
  /** perChannel[ch] = 本批新增的采样值数组（按到达顺序） */
  perChannel: number[][]
  /** 不足一个 record 的零头，原样传回给下次 parseSamples 的 carryover */
  remainder: Uint8Array
}

/**
 * 把字节流切成若干 record，读出每通道数值。
 *
 * @param bytes 本批到达的字节
 * @param cfg   解析配置
 * @param carryover 上批遗留的零头（会被拼到 bytes 前）
 */
export function parseSamples(
  bytes: Uint8Array,
  cfg: WaveformParseConfig,
  carryover: Uint8Array = new Uint8Array(0)
): ParseResult {
  const channels = Math.max(1, cfg.channels)
  const off = Math.max(0, cfg.byteOffset)
  const bps = bytesPerSample(cfg.type)
  const size = off + channels * bps

  // 拼接 carryover + bytes（carryover 长度必 < size，故总长有界）
  const total = carryover.length + bytes.length
  const buf = new Uint8Array(total)
  buf.set(carryover, 0)
  buf.set(bytes, carryover.length)

  // 不足一个 record → 全部作为零头返回
  if (size <= 0 || total < size) {
    return {
      perChannel: Array.from({ length: channels }, () => []),
      remainder: buf
    }
  }

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const fullRecords = Math.floor(total / size)
  const perChannel: number[][] = Array.from({ length: channels }, () => [])

  for (let r = 0; r < fullRecords; r++) {
    const base = r * size + off
    for (let c = 0; c < channels; c++) {
      perChannel[c].push(readSample(dv, base + c * bps, cfg.type, cfg.littleEndian))
    }
  }

  const remainderLen = total - fullRecords * size
  const remainder =
    remainderLen > 0 ? buf.slice(fullRecords * size, fullRecords * size + remainderLen) : new Uint8Array(0)

  return { perChannel, remainder }
}

/** 按 DataView 读取一个数值，单字节类型忽略 littleEndian */
function readSample(dv: DataView, offset: number, type: NumericType, le: boolean): number {
  switch (type) {
    case 'uint8':
      return dv.getUint8(offset)
    case 'int8':
      return dv.getInt8(offset)
    case 'uint16':
      return dv.getUint16(offset, le)
    case 'int16':
      return dv.getInt16(offset, le)
    case 'uint32':
      return dv.getUint32(offset, le)
    case 'int32':
      return dv.getInt32(offset, le)
    case 'float32':
      return dv.getFloat32(offset, le)
    case 'float64':
      return dv.getFloat64(offset, le)
  }
}
