import type { ThemeDefinition, ThemeTokens } from './types'
import { glassIndustrialDark } from './builtin/glass-industrial-dark'
import { glassIndustrialLight } from './builtin/glass-industrial-light'
import { oledHud } from './builtin/oled-hud'

const registry = new Map<string, ThemeDefinition>()

register(glassIndustrialDark)
register(glassIndustrialLight)
register(oledHud)

export function register(theme: ThemeDefinition): void {
  registry.set(theme.id, theme)
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return registry.get(id)
}

export function listThemes(): ThemeDefinition[] {
  return Array.from(registry.values())
}

/**
 * 应用 CSS 变量到 :root 的 style 属性，同时设置 data-theme。
 * 纯函数，可在 main.ts createApp 前同步执行。
 */
export function applyTokens(tokens: ThemeTokens, isDark: boolean): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    if (value != null) root.style.setProperty(key, value)
  }
  root.setAttribute('data-theme', isDark ? 'dark' : 'light')
}

/** 当前激活主题（管理字体预加载去重） */
let activeThemeId: string | null = null

/**
 * 应用主题附带字体：仅预加载 --display-font，避免 FOIT
 * （首字 fallback → 实际字体闪烁）。字体文件由 styles/fonts.css 的
 * @font-face 声明加载，这里只是提前触发浏览器下载/解析。
 */
export function applyFonts(theme: ThemeDefinition): void {
  if (typeof document === 'undefined') return
  if (activeThemeId === theme.id) return
  activeThemeId = theme.id

  const displayFont = theme.tokens['--display-font']
  if (displayFont && typeof (document as Document).fonts?.load === 'function') {
    // 解析字体族名（取第一个，去引号）
    const family = displayFont.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    void (document as Document).fonts.load(`700 16px "${family}"`).catch(() => {})
  }
}
