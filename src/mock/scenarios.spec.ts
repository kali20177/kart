import { describe, it, expect } from 'vitest'
import { MockShell, shellBanner, modbusSample, waveformMarkerChunk } from '@/mock/scenarios'
import { modbusRtuDecoder } from '@/decoders/builtin/modbus-rtu'
import { parseTextSamples } from '@/utils/waveform/text-parser'

const dec = new TextDecoder()
const enc = new TextEncoder()

describe('MockShell · 回显与命令应答', () => {
  it('按键即时回显', () => {
    const sh = new MockShell()
    expect(dec.decode(sh.process(enc.encode('ls')))).toBe('ls')
  })

  it('回车触发命令应答并以提示符结尾', () => {
    const sh = new MockShell()
    sh.process(enc.encode('ls'))
    const out = dec.decode(sh.process(enc.encode('\r')))
    expect(out).toContain('\r\n')
    expect(out).toContain('app')
    expect(out).toContain('root@kart:~#')
  })

  it('退格删除本地行并回显 \b \b', () => {
    const sh = new MockShell()
    sh.process(enc.encode('ab'))
    expect(dec.decode(sh.process(enc.encode('\x7f')))).toBe('\b \b')
    expect(dec.decode(sh.process(enc.encode('c\r')))).toContain('sh: ac: command not found')
  })

  it('退格按字符显示宽度擦除——CJK 宽字符需 \b \b 两次', () => {
    const sh = new MockShell()
    sh.process(enc.encode('缓'))
    expect(dec.decode(sh.process(enc.encode('\x7f')))).toBe('\b \b\b \b')
    // 宽字符删除后再输入 ASCII，行缓冲不受残留影响
    const out = dec.decode(sh.process(enc.encode('ok\r')))
    expect(out).toContain('sh: ok: command not found')
  })

  it('tab 无唯一补全时不回显字面 tab（避免光标被推到制表位）', () => {
    const sh = new MockShell()
    sh.process(enc.encode('cd lo'))
    const out = dec.decode(sh.process(enc.encode('\t')))
    expect(out).toBe('')
    // 光标未移动，退格仍能正常擦除最后一个字符
    expect(dec.decode(sh.process(enc.encode('\x7f')))).toBe('\b \b')
  })

  it('tab 唯一前缀补全为命令 + 空格', () => {
    const sh = new MockShell()
    sh.process(enc.encode('he'))
    const out = dec.decode(sh.process(enc.encode('\t')))
    expect(out).toBe('lp ')
  })

  it('Ctrl+C 清行并回显 ^C + 新提示符', () => {
    const sh = new MockShell()
    sh.process(enc.encode('abc'))
    const out = dec.decode(sh.process(enc.encode('\x03')))
    expect(out).toContain('^C\r\n')
    expect(out).toContain('root@kart:~#')
  })

  it('cat 已知文件输出内容；未知文件报错', () => {
    const sh = new MockShell()
    const ok = dec.decode(sh.process(enc.encode('cat config\r')))
    const sh2 = new MockShell()
    const notFound = dec.decode(sh2.process(enc.encode('cat nope\r')))
    expect(ok).toContain('baud=115200')
    expect(notFound).toContain('No such file or directory')
  })

  it('未知命令报 command not found', () => {
    const sh = new MockShell()
    const out = dec.decode(sh.process(enc.encode('foo\r')))
    expect(out).toContain('sh: foo: command not found')
  })

  it('clear 输出 ANSI 清屏序列', () => {
    const sh = new MockShell()
    const out = dec.decode(sh.process(enc.encode('clear\r')))
    expect(out).toContain('\x1b[2J\x1b[H')
  })

  it('banner 含提示符且用 CRLF 换行（裸 LF 会让 xterm 只换行不回列导致错位）', () => {
    const banner = dec.decode(shellBanner())
    expect(banner).toContain('root@kart:~#')
    expect(banner).toContain('\r\n')
    expect(banner).not.toMatch(/[^\r]\n/)
  })
})

describe('modbusSample · Modbus RTU 场景帧', () => {
  it('应答帧（seq%5!==0）：fc03 + byteCount=8 + 4 寄存器，解码器可解析', () => {
    const r = modbusRtuDecoder.decode(modbusSample(1))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'byteCount')?.value).toBe('8')
    const regs = r.fields?.find((f) => f.name === 'registers')?.value ?? ''
    expect(regs.split(', ')).toHaveLength(4)
    expect(regs).toMatch(/^0x[0-9A-F]{4}(, 0x[0-9A-F]{4}){3}$/)
  })

  it('请求帧（seq%5===0）：fc03 读起始 0x0000 数量 4', () => {
    const r = modbusRtuDecoder.decode(modbusSample(0))
    expect(r.matched).toBe(true)
    expect(r.fields?.find((f) => f.name === 'reg')?.value).toBe('0x0000')
    expect(r.fields?.find((f) => f.name === 'count')?.value).toBe('4')
  })

  it('寄存器值随 seq 变化（温度/电压/电流逐 tick 不同）', () => {
    const regsOf = (seq: number) =>
      modbusRtuDecoder.decode(modbusSample(seq)).fields?.find((f) => f.name === 'registers')?.value
    expect(regsOf(2)).not.toBe(regsOf(3))
  })
})

/**
 * 这一组测试守的是「场景作为夹具的可用性」：绘图标记的四种验证路径都靠它复现，
 * 生成函数一旦漂移（少了标记、日志不再带裸数字），夹具就失效了。
 */
describe('waveformMarkerChunk · 绘图标记混流场景', () => {
  const valuesOf = (perChannel: number[][]) => perChannel.flat().filter((v) => !Number.isNaN(v))
  const linesOf = (seq: number) => dec.decode(waveformMarkerChunk(seq)).split('\r\n').filter(Boolean)

  it('一组两行：不带标记的日志行 + 行首带标记的绘图行', () => {
    const ls = linesOf(0)
    expect(ls).toHaveLength(2)
    expect(ls[0].startsWith('[')).toBe(true)
    expect(ls[1].startsWith('>')).toBe(true) // 标记顶格
  })

  it('宽松模式（标记留空）：日志里的裸数字被当成采样值——即本场景要展示的污染', () => {
    const r = parseTextSamples(waveformMarkerChunk(3), '', new Map())
    expect(valuesOf(r.perChannel).some((v) => v > 100000)).toBe(true) // 日志里的 Pa 读数
  })

  it('标记模式（填 >）：恰为 Temp / Pressure 两通道，读数在 BMP180 量程内', () => {
    const idx = new Map<string, number>()
    const r = parseTextSamples(waveformMarkerChunk(3), '', idx, { linePrefix: '>' })
    expect([...idx.keys()]).toEqual(['Temp', 'Pressure'])
    expect(r.rejected).toEqual([])
    expect(r.unmarkedLines).toBe(1) // 日志行被当文本：不成点，也不算被拒
    expect(r.perChannel[0][0]).toBeGreaterThan(10)
    expect(r.perChannel[0][0]).toBeLessThan(45)
    expect(r.perChannel[1][0]).toBeGreaterThan(900)
    expect(r.perChannel[1][0]).toBeLessThan(1100)
  })

  it('标记设成日志行前缀（如 [CLO）：日志行以标记开头但内容非法 -> 整行作废（面板出红标）', () => {
    const r = parseTextSamples(waveformMarkerChunk(3), '', new Map(), { linePrefix: '[CLO' })
    expect(r.rejected).toHaveLength(1)
    expect(r.unmarkedLines).toBe(1) // 绘图行这时反而成了「未匹配标记」的行
    expect(valuesOf(r.perChannel)).toEqual([])
  })

  it('标记与设备对不上（如 |）：一条数据都不成点（面板出「未见以 | 开头」提示）', () => {
    const r = parseTextSamples(waveformMarkerChunk(3), '', new Map(), { linePrefix: '|' })
    expect(r.rejected).toEqual([])
    expect(r.unmarkedLines).toBe(2) // 日志行 + 绘图行都不匹配
    expect(valuesOf(r.perChannel)).toEqual([])
  })
})
