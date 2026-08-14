import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * 全部主题 CSS 自定义属性的键集合（const 联合）。
 */
export const TOKEN_KEYS = [
  '--bg', '--bg-panel', '--bg-elevated', '--text', '--text-dim', '--border',
  '--accent', '--accent-cyan', '--accent-teal', '--ok', '--warn', '--err',
  '--rx-bg', '--rx-border', '--rx-text', '--tx-bg', '--tx-border', '--tx-text',
  '--glass-bg', '--glass-border', '--glass-blur', '--glass-blur-sm',
  '--glass-highlight', '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--radius', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--gap',
  '--search-highlight-bg', '--search-highlight-text',
  '--search-active-bg', '--search-active-text',
  '--mono-font', '--ui-font', '--display-font', '--display-letter-spacing', '--ascii-btn-font',
] as const
export type TokenKey = typeof TOKEN_KEYS[number]

/** 单套 CSS 自定义属性 */
export type ThemeTokens = Partial<Record<TokenKey, string>>

/** 一个完整主题定义（单态：每个文件只定一种明暗） */
export interface ThemeDefinition {
  id: string
  name: string
  description?: string
  /** 是否为暗色（供 uPlot 等 JS 逻辑判断配色） */
  isDark: boolean
  /** 该主题的 CSS 变量值 */
  tokens: ThemeTokens
  /** Naive UI 主题覆写（可选） */
  naiveOverrides?: GlobalThemeOverrides
}
