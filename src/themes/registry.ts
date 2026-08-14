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

/** 已为某主题注入的外部字体 URL（避免重复插入 <link>） */
const loadedFontUrls = new Set<string>()
/** 当前激活主题（管理字体注入/卸载） */
let activeThemeId: string | null = null

/**
 * 应用主题附带字体：插入 Google Fonts <link>，并在切换到不依赖这些字体的主题时移除。
 * 重复切换同一主题或同 URL 不重复插 DOM。
 */
export function applyFonts(theme: ThemeDefinition): void {
  if (typeof document === 'undefined') return
  if (activeThemeId === theme.id) return
  activeThemeId = theme.id

  // 移除旧主题的字体 link（按 data-theme-font 标记）
  const oldLinks = document.querySelectorAll<HTMLLinkElement>('link[data-theme-font]')
  for (const link of oldLinks) {
    const url = link.getAttribute('data-theme-font') ?? ''
    if (!(theme.fonts ?? []).includes(url)) {
      link.remove()
      loadedFontUrls.delete(url)
    }
  }

  // 插入新主题字体
  for (const url of theme.fonts ?? []) {
    if (loadedFontUrls.has(url)) continue
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    link.setAttribute('data-theme-font', url)
    document.head.appendChild(link)
    loadedFontUrls.add(url)
  }

  // 主题用 --display-font 时强制预加载，避免 FOIT（首字 fallback → 实际字体闪烁）
  const displayFont = theme.tokens['--display-font']
  if (displayFont && typeof (document as Document).fonts?.load === 'function') {
    // 解析字体族名（取第一个，去引号）
    const family = displayFont.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    void (document as Document).fonts.load(`700 16px "${family}"`).catch(() => {})
  }
}
