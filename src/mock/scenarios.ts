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
  },
  {
    id: 'buffer-flood',
    label: '缓冲灌满压测',
    description: '高频数值行灌入，快速触发消息/波形缓冲丢弃；建议配合「分隔符 \\n」帧策略'
  },
  {
    id: 'shell',
    label: 'Shell 交互终端',
    description: '模拟嵌入式 Linux 串口 console（回显 + 行编辑 + 常用命令），配合终端视图体验'
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

/**
 * 缓冲灌满压测帧：每 tick 吐出一大段换行分隔的数值行。
 * 配合「分隔符 \n」帧策略时一 tick 即切出数百帧，几秒内灌满消息缓冲/波形历史，
 * 触发「已丢弃 N 帧」/「已丢弃 N 采样」提示；数值行同时是合法的波形采样（2 通道）。
 *
 * @param linesPerChunk 单批行数（≈帧数），配合 bufferLimit/maxHistoryPoints 调触发速度
 */
export function bufferFloodChunk(linesPerChunk = 500): Uint8Array {
  let s = ''
  for (let i = 0; i < linesPerChunk; i++) {
    const a = Math.floor(Math.random() * 1024)
    const b = Math.floor(Math.random() * 1024)
    s += `${a},${b}\r\n`
  }
  return text(s)
}

// —— Shell 交互终端场景 ——
// 模拟嵌入式 Linux 串口 console：设备侧回显 + 行编辑 + 常用命令应答（带 ANSI 颜色），
// 用于无硬件时自测终端视图（char 直通 / line 发送 / 退格 / tab 补全 / Ctrl+C）。

const SHELL_PROMPT = '\x1b[1;32mroot@kart:~# \x1b[0m'

const SHELL_BANNER =
  '\x1b[1;34mKART 模拟串口终端\x1b[0m\r\n' +
  '嵌入式 Linux console 模拟（设备回显 + 行编辑）。命令：help / ls / cat / echo / clear / color / uname / vim\r\n' +
  SHELL_PROMPT

const SHELL_FILES: Record<string, string> = {
  app: '#!/bin/sh\r\nKART_SHELL=1\r\nexec /sbin/init',
  config: 'baud=115200\r\nlog_level=debug\r\nterminal=vt100'
}

const SHELL_HELP =
  '可用命令：\r\n' +
  '  help             显示帮助\r\n' +
  '  ls               列出文件\r\n' +
  '  cat <file>       查看文件（app / config）\r\n' +
  '  echo <text>      输出文本\r\n' +
  '  clear            清屏\r\n' +
  '  color            显示 ANSI 颜色\r\n' +
  '  uname            内核信息\r\n' +
  '  vim              提示全屏编辑器支持状态'

const SHELL_COMMANDS = ['help', 'ls', 'cat', 'echo', 'clear', 'color', 'uname', 'vim']

function shellLs(): string {
  return ['\x1b[1;34mapp\x1b[0m', '\x1b[1;34mconfig\x1b[0m', '\x1b[1;34mlogs\x1b[0m', 'start.sh', 'kernel.bin'].join(
    '  '
  )
}

function shellColorDemo(): string {
  let out = '前景色：'
  for (let i = 30; i <= 37; i++) out += `\x1b[${i}m fg${i} \x1b[0m`
  out += '\r\n加粗：'
  for (let i = 30; i <= 37; i++) out += `\x1b[1;${i}mB${i}\x1b[0m `
  return out
}

/** 连接时打印的 banner */
export function shellBanner(): Uint8Array {
  return text(SHELL_BANNER)
}

/** 终端显示宽度：CJK/全角等宽字符占 2 列，其余 1 列（退格擦除需按此计数，否则宽字符删不干净） */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首扩展..彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6)    // 全角符号
  ) return 2
  return 1
}

/** 模拟 shell：对写入的字节做设备侧回显 + 行编辑 + 命令应答 */
export class MockShell {
  private line = ''

  /** 处理一段输入，返回应回显到终端的全部字节（按键回显 + 命令应答） */
  process(bytes: Uint8Array): Uint8Array {
    const decoded = new TextDecoder().decode(bytes)
    const parts: string[] = []
    for (const ch of decoded) {
      const code = ch.codePointAt(0) ?? 0
      if (ch === '\r' || ch === '\n') {
        const out = this.exec(this.line)
        this.line = ''
        parts.push('\r\n', out)
      } else if (ch === '\b' || code === 0x7f) {
        if (this.line.length) {
          const removed = this.line.slice(-1)
          this.line = this.line.slice(0, -1)
          // 按字符显示宽度擦除（CJK 宽字符占 2 列）
          parts.push('\b \b'.repeat(charWidth(removed)))
        }
      } else if (ch === '\t') {
        const completed = this.complete()
        if (completed) {
          const rest = completed.slice(this.line.length)
          this.line = completed
          parts.push(rest)
        }
        // 无唯一补全：不回显字面 tab（会移动光标到制表位、与文本脱节），保持光标不动
      } else if (code === 0x03) {
        this.line = ''
        parts.push('^C\r\n', SHELL_PROMPT)
      } else if (code >= 0x20 && code !== 0x7f) {
        this.line += ch
        parts.push(ch)
      }
      // 其余控制字符（含方向键转义序列的中间字节）忽略回显
    }
    return text(parts.join(''))
  }

  /** tab 补全：唯一前缀匹配时补全为命令 + 空格 */
  private complete(): string | null {
    if (!this.line) return null
    const hits = SHELL_COMMANDS.filter((c) => c.startsWith(this.line))
    if (hits.length === 1 && hits[0] !== this.line) return hits[0] + ' '
    return null
  }

  private exec(raw: string): string {
    const cmd = raw.trim()
    if (!cmd) return SHELL_PROMPT
    const [name, ...args] = cmd.split(/\s+/)
    switch (name) {
      case 'help': return SHELL_HELP + '\r\n' + SHELL_PROMPT
      case 'ls': return shellLs() + '\r\n' + SHELL_PROMPT
      case 'cat': {
        const f = args[0]
        if (f && f in SHELL_FILES) return SHELL_FILES[f] + '\r\n' + SHELL_PROMPT
        return `cat: ${f ?? ''}: No such file or directory\r\n` + SHELL_PROMPT
      }
      case 'echo': return (args.join(' ') || '') + '\r\n' + SHELL_PROMPT
      case 'clear': return '\x1b[2J\x1b[H' + SHELL_PROMPT
      case 'color': return shellColorDemo() + '\r\n' + SHELL_PROMPT
      case 'uname': return 'Linux kart 5.15.41 armv7l GNU/Linux\r\n' + SHELL_PROMPT
      case 'vim': return 'vim: 全屏编辑器（alt-screen）在终端模式阶段三支持\r\n' + SHELL_PROMPT
      default: return `sh: ${name}: command not found\r\n` + SHELL_PROMPT
    }
  }
}
