import type { MockScenarioId } from '@/types'

export interface ScenarioDef {
  id: MockScenarioId
  label: string
  description: string
}

export const SCENARIOS: ScenarioDef[] = [
  { id: 'silent', label: '静默', description: '已连接但无自动数据' },
  { id: 'at-reply', label: 'AT 应答', description: '每次发送后模拟一段 ASCII 回复' },
  { id: 'binary-frames', label: '二进制连续帧', description: '周期吐出带帧头 AA 55 的 hex 帧' },
  { id: 'high-throughput', label: '高吞吐压测', description: '高频灌数据，验证虚拟滚动与节流' },
  { id: 'mixed-ascii', label: '混合 ASCII', description: '周期日志 + 偶发中文（GBK）' }
]

const encoder = new TextEncoder()

/** 把字符串编为 utf-8 字节 */
export function text(s: string): Uint8Array {
  return encoder.encode(s)
}

/** GBK 编码的中文（演示 GBK 解码）—— "温度: 26℃\r\n" 的 GBK 字节，硬编码避免依赖编码库 */
export function gbkSample(): Uint8Array {
  // "温度:" GBK: CE C2 B6 C8 3A 20  + "26" + "℃"(GBK A1E6) + "\r\n"
  return new Uint8Array([0xce, 0xc2, 0xb6, 0xc8, 0x3a, 0x20, 0x32, 0x36, 0xa1, 0xe6, 0x0d, 0x0a])
}

/** AT 指令对应的模拟应答 */
export function atResponse(sent: string): Uint8Array {
  const cmd = sent.trim().toUpperCase()
  if (cmd === 'AT') return text('OK\r\n')
  if (cmd === 'AT+CSQ') return text('+CSQ: 24,99\r\nOK\r\n')
  if (cmd === 'AT+CGMI') return text('SIMCom\r\nOK\r\n')
  if (cmd === 'AT+GMR' || cmd === 'AT+CGMR') return text('Revision: 1.02.04\r\nOK\r\n')
  if (cmd.startsWith('AT')) return text('OK\r\n')
  return text('ERROR\r\n')
}

/** 二进制帧：AA 55 <len> <payload...> <xor校验> */
export function binaryFrame(seq: number): Uint8Array {
  const payload = new Uint8Array([seq & 0xff, (seq >> 8) & 0xff, 0x10, 0x20, 0x30, 0x40])
  const len = payload.length
  let xor = 0
  for (const b of payload) xor ^= b
  return new Uint8Array([0xaa, 0x55, len, ...payload, xor])
}

/** 高吞吐：一段 64 字节的可打印数据 */
export function throughputChunk(seq: number): Uint8Array {
  const line = `#${seq.toString().padStart(6, '0')} ` + 'DATA'.repeat(13) + '\r\n'
  return text(line.slice(0, 64))
}

/** 混合日志行 */
export function logLine(seq: number): Uint8Array {
  const levels = ['INFO', 'WARN', 'DEBUG']
  const lvl = levels[seq % levels.length]
  return text(`[${lvl}] tick=${seq} heap=${1024 - (seq % 256)}\r\n`)
}
