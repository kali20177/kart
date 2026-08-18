// ACK 匹配的纯判定逻辑（可单测）。waitForAck 在 store 侧负责订阅/计时/缓冲，
// 字节级判定集中在这里，契约与 wire 格式保持一致（CRC 小端、NACK=0x15）。

/** NACK 字节（ASCII NAK）——byte / echo-crc 模式收到即判定失败重试 */
export const NACK_BYTE = 0x15

export function isNackByte(b: number): boolean {
  return b === NACK_BYTE
}

/** 两个字节按小端合成 16 位值（与 checksum.ts 的小端字节序一致） */
export function le16(a: number, b: number): number {
  return (a & 0xff) | ((b & 0xff) << 8)
}

/**
 * echo-crc：前两个回吐字节按小端与期望 CRC 比对。
 * 缓冲不足 2 字节时返回 false（继续等待），由调用方累积缓冲。
 */
export function matchEchoCrc(buffer: number[], expected: number): boolean {
  if (buffer.length < 2) return false
  return le16(buffer[0], buffer[1]) === expected
}