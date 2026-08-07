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

  it('banner 含提示符', () => {
    expect(dec.decode(shellBanner())).toContain('root@kart:~#')
  })
})
