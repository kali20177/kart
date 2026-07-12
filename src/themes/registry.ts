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
