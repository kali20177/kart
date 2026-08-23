import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyTheme } from './registry'
import type { ThemeDefinition } from './types'

const theme: ThemeDefinition = {
  id: 'test-theme',
  name: 'Test',
  isDark: true,
  tokens: {
    '--bg': '#111',
    '--accent': '#0af',
    '--ui-font': 'Inter, sans-serif',
  },
}

const root = document.documentElement
const KEYS = ['--bg', '--accent', '--ui-font', '--chat-bg']

function cleanup() {
  root.removeAttribute('data-theme-id')
  root.removeAttribute('data-theme')
  for (const k of KEYS) root.style.removeProperty(k)
}

beforeEach(cleanup)
afterEach(cleanup)

describe('applyTheme', () => {
  it('设置 data-theme-id 与 data-theme（特征层选择器 + 明暗）', () => {
    applyTheme(theme)
    expect(root.getAttribute('data-theme-id')).toBe('test-theme')
    expect(root.getAttribute('data-theme')).toBe('dark')
  })

  it('把 tokens 写入 :root 的 style', () => {
    applyTheme(theme)
    expect(root.style.getPropertyValue('--bg')).toBe('#111')
    expect(root.style.getPropertyValue('--accent')).toBe('#0af')
  })

  it('用户覆盖优先级高于主题 tokens', () => {
    applyTheme(theme, { '--accent': '#f00' })
    expect(root.style.getPropertyValue('--accent')).toBe('#f00')
    // 未覆盖的 key 仍用主题 token
    expect(root.style.getPropertyValue('--bg')).toBe('#111')
  })

  it('overrides 空串视为不覆盖（回退主题值）；非空覆盖生效', () => {
    applyTheme(theme, { '--bg': '', '--chat-bg': '#00f' })
    expect(root.style.getPropertyValue('--bg')).toBe('#111')
    expect(root.style.getPropertyValue('--chat-bg')).toBe('#00f')
  })

  it('清空覆盖后移除之前写入的键（含非 token 键 --chat-bg），不残留旧值', () => {
    // 非 token 键：只经覆盖写入，清空后必须移除、回落 CSS 默认
    applyTheme(theme, { '--chat-bg': '#00f' })
    expect(root.style.getPropertyValue('--chat-bg')).toBe('#00f')
    applyTheme(theme, { '--chat-bg': '' })
    expect(root.style.getPropertyValue('--chat-bg')).toBe('')
    // 主题 token 键：清空后回退主题值而非残留覆盖值
    applyTheme(theme, { '--ui-font': 'SomeFont' })
    expect(root.style.getPropertyValue('--ui-font')).toBe('SomeFont')
    applyTheme(theme, {})
    expect(root.style.getPropertyValue('--ui-font')).toBe('Inter, sans-serif')
  })
})
