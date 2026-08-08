import { describe, it, expect } from 'vitest'
import { MockShell, shellBanner } from './scenarios'

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
