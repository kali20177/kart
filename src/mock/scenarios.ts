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
    id: 'waveform-text',
    label: 'Arduino 文本绘图',
    description: 'Serial.println 风格 ASCII 数字行，配合文本行解析 + 2 通道'
  },
  {
    id: 'waveform-text-labeled',
    label: 'Arduino 标签化文本',
    description: 'Serial.println 标签化多通道（Sin:0.5, Cos:0.86），自动检测通道名'
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
 * Arduino 文本绘图风格帧：Serial.println 风格的 ASCII 数字行。
 * 每行两个逗号分隔的整数，模拟：
 *   Serial.print(a); Serial.print(','); Serial.println(b);
 *
 * - ch0 = round(sin(2π·2·t) · 512 + 512 + 噪声)  正弦摆动在 0~1024（analogRead 量程）+ ±20 噪声
 * - ch1 = round(cos(2π·2·t) · 512 + 512 + 噪声)  余弦正交相位 + ±20 噪声
 * - t = seq / 20（每 50ms 一行 -> 20 行/秒）
 *
 * 配合波形「文本行」解析模式 + 2 通道。整行为 ASCII 数字 + 逗号 + \r\n，
 * 直接验证文本解析路径（TextDecoder 解码 -> 按行切 -> 数字解析 -> 多通道采样）。
 *
 * @param seq 已发送的行序号，决定时间轴起点
 */
export function waveformTextChunk(seq: number): Uint8Array {
  const t = seq / 20
  const a = Math.round(Math.sin(2 * Math.PI * 2 * t) * 512 + 512 + (Math.random() - 0.5) * 40)
  const b = Math.round(Math.cos(2 * Math.PI * 2 * t) * 512 + 512 + (Math.random() - 0.5) * 40)
  return text(`${a},${b}\r\n`)
}

/**
 * Arduino 标签化文本帧：Serial.println 风格的 label:value 多通道行。
 * 模拟 Arduino 中常见的多传感器采集场景：
 *   Serial.print("Temp:");  Serial.print(tmp);
 *   Serial.print(",Hum:");   Serial.print(hum);
 *   Serial.print(",Pres:");  Serial.print(pres);
 *   Serial.print(",Alt:");   Serial.print(alt);
 *   Serial.print(",Bat:");   Serial.print(bat);
 *   Serial.print(",RSSI:");  Serial.println(rssi);
 *
 * 6 通道包含不同类型信号：慢变漂移、周期振荡、白噪声、阶跃下降，
 * 用于验证标签化解析的动态通道增长、通道重排、图表多色显示。
 *
 * @param seq 已发送的行序号，决定时间轴起点
 */
export function waveformTextLabeledChunk(seq: number): Uint8Array {
  const t = seq / 20
  // 温度：25°C 基线 + 0.005Hz 慢变 ±3°C + 噪声
  const temp = (25 + 3 * Math.sin(2 * Math.PI * 0.005 * t) + (Math.random() - 0.5) * 0.3).toFixed(2)
  // 湿度：60% 基线 + 2Hz 微幅 + 噪声
  const hum = (60 + 5 * Math.sin(2 * Math.PI * 2 * t) + (Math.random() - 0.5) * 4).toFixed(1)
  // 气压：1013 hPa 基线 + 0.03Hz 慢变 ±5 + 噪声
  const pres = (1013 + 5 * Math.sin(2 * Math.PI * 0.03 * t) + (Math.random() - 0.5) * 2).toFixed(1)
  // 海拔：120m 基线 + 0.02Hz 慢变 ±15m（与气压负相关）+ 噪声
  const alt = (120 - 15 * Math.sin(2 * Math.PI * 0.03 * t) + (Math.random() - 0.5) * 3).toFixed(1)
  // 电池：3.7V 基线 - 0.00005×seq 缓慢消耗（模拟 0.005%/行）+ 噪声
  const bat = (3.7 - seq * 0.00005 + (Math.random() - 0.5) * 0.01).toFixed(3)
  // RSSI：-65dBm 基线 + 摆动 + 突发深衰（20% 概率额外跌 10-15dB）
  let rssi = -65 + 4 * Math.sin(2 * Math.PI * 0.5 * t) + (Math.random() - 0.5) * 6
  if (Math.random() < 0.2) rssi -= 10 + Math.random() * 15
  const rssiInt = Math.round(rssi)

  return text(
    `Temp:${temp},Hum:${hum},Pres:${pres},Alt:${alt},Bat:${bat},RSSI:${rssiInt}\r\n`
  )
}
