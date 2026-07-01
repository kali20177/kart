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
  { id: 'mixed-ascii', label: '混合 ASCII', description: '周期日志 + 偶发中文（GBK）' },
  {
    id: 'waveform',
    label: '波形采样',
    description: '结构化二进制多通道采样，配合波形视图'
  }
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

/**
 * 波形采样帧：32 采样 × 2 通道 × int16 LE = 128 字节。
 * 通道交错排列（与解析器 record 模型一致）：[s0ch0, s0ch1, s1ch0, s1ch1, …]。
 *
 * 故意加入慢变调制 + 噪声，使信号非纯周期：滑动窗口滚满后，新进数据与滚出数据
 * 不再逐周期重复，波形持续可见变化（更像真实传感器：慢漂移 + 周期信号 + 白噪声）。
 *
 * - ch0 = round(sin(2π·2·t) · env + 噪声)
 *        env = 16000 + 6000·sin(2π·0.1·t)   2 Hz 正弦，幅度被 0.1Hz 包络调制（10000–22000）+ ±400 噪声
 * - ch1 = round(sin(2π·5·t) · 12000 + drift + 噪声)
 *        drift = 4000·sin(2π·0.07·t)        5 Hz 正弦 + 0.07Hz 慢变直流偏置（±4000）+ ±800 噪声
 * - t = (seq*32 + i) / 640（每 50ms 一帧 → 640 采样/秒）
 * - 所有幅度 ≤ ±22000，int16 安全（±32767）
 *
 * @param seq 已发送的帧序号，决定时间轴起点
 */
export function waveformChunk(seq: number): Uint8Array {
  const samples = 32
  const buf = new Uint8Array(samples * 2 * 2) // 32 采样 × 2 通道 × 2 字节
  const dv = new DataView(buf.buffer)
  let w = 0
  for (let i = 0; i < samples; i++) {
    const t = (seq * samples + i) / 640
    // ch0：2Hz 正弦 × 0.1Hz 慢变包络 + 小噪声
    const env = 16000 + 6000 * Math.sin(2 * Math.PI * 0.1 * t)
    const ch0 = Math.round(Math.sin(2 * Math.PI * 2 * t) * env + (Math.random() - 0.5) * 800)
    // ch1：5Hz 正弦 + 0.07Hz 慢变直流偏置 + 噪声
    const drift = 4000 * Math.sin(2 * Math.PI * 0.07 * t)
    const ch1 = Math.round(Math.sin(2 * Math.PI * 5 * t) * 12000 + drift + (Math.random() - 0.5) * 1600)
    dv.setInt16(w, ch0, true)
    w += 2
    dv.setInt16(w, ch1, true)
    w += 2
  }
  return buf
}
