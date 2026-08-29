import { describe, it, expect } from 'vitest'
import { resolveTerminalPalette } from './terminal'
import { listThemes } from './registry'
import { TERMINAL_PALETTE_KEYS } from './types'
import type { ThemeDefinition } from './types'

const baseTheme: ThemeDefinition = {
  id: 'test-theme',
  name: 'Test',
  isDark: true,
  tokens: {},
}

/** selectionForeground 留空 = xterm 默认保留选区下原文字色 */
const REQUIRED_KEYS = TERMINAL_PALETTE_KEYS.filter((k) => k !== 'selectionForeground')

describe('resolveTerminalPalette', () => {
  it('未指定 terminal 的暗色主题回落暗色基线（不再黑底白字硬编码之外的歧义）', () => {
    const pal = resolveTerminalPalette(baseTheme)
    expect(pal.background).toBe('#10151b')
    expect(pal.foreground).toBe('#e6edf3')
    expect(pal.red).toBeDefined()
  })

  it('未指定 terminal 的亮色主题回落亮色基线（亮底深字）', () => {
    const pal = resolveTerminalPalette({ ...baseTheme, isDark: false })
    expect(pal.background).toBe('#ffffff')
    expect(pal.foreground).toBe('#24292f')
  })

  it('主题 terminal 键逐键覆盖基线，缺省键仍回落基线', () => {
    const pal = resolveTerminalPalette({
      ...baseTheme,
      terminal: { background: '#123456', green: '#00ff00' },
    })
    expect(pal.background).toBe('#123456')
    expect(pal.green).toBe('#00ff00')
    // 未指定的键仍就位
    expect(pal.foreground).toBe('#e6edf3')
    expect(pal.brightCyan).toBeDefined()
  })

  it('全部内置主题的调色板键完整、值均为合法 CSS 颜色', () => {
    const colorRe = /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/
    for (const theme of listThemes()) {
      const pal = resolveTerminalPalette(theme)
      for (const key of REQUIRED_KEYS) {
        const v = pal[key]
        expect(v, `${theme.id}.${key}`).toBeTruthy()
        expect(v, `${theme.id}.${key}`).toMatch(colorRe)
      }
    }
  })

  it('亮暗主题的终端底色与各自 --bg-panel token 一致（视口无色差拼接缝）', () => {
    for (const theme of listThemes()) {
      const pal = resolveTerminalPalette(theme)
      expect(pal.background, theme.id).toBe(theme.tokens['--bg-panel'])
    }
  })
})
