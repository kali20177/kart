import { describe, it, expect } from 'vitest'
import { resolveCharHintKind } from './terminal-hint'

describe('resolveCharHintKind', () => {
  it('非 TCP（串口）→ hidden：直通提示只属于 TCP 传输，串口不渲染提示条（回归）', () => {
    expect(resolveCharHintKind(false, false, false)).toBe('hidden')
    expect(resolveCharHintKind(true, false, false)).toBe('hidden')
    expect(resolveCharHintKind(true, true, false)).toBe('hidden')
  })

  it('TCP 未连接 → needConnect', () => {
    expect(resolveCharHintKind(false, false, true)).toBe('needConnect')
    expect(resolveCharHintKind(false, true, true)).toBe('needConnect')
  })

  it('TCP 已连接 + 本地回显开 → echoOn', () => {
    expect(resolveCharHintKind(true, true, true)).toBe('echoOn')
  })

  it('TCP 已连接 + 回显关 → tcpNoEcho 警示（对端无回显则输入不可见）', () => {
    expect(resolveCharHintKind(true, false, true)).toBe('tcpNoEcho')
  })
})
