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

/**
 * 应用完整主题：CSS 变量 + data-theme + data-theme-id（特征覆盖层选择器）。
 * data-theme-id 供每主题特征 CSS（src/styles/themes/<id>.css）按 [data-theme-id=…] 做
 * 全局形状语言强制（如像素风的硬边框/阶梯阴影/硬切过渡），弥补 token 只达 var() 引用处、
 * 碰不到 Naive 组件内部与 hover/focus 等角落的缺口。
 */
export function applyTheme(
  theme: ThemeDefinition,
  overrides?: Record<string, string>,
): void {
  applyTokens(theme.tokens, theme.isDark)
  document.documentElement.setAttribute('data-theme-id', theme.id)
  // 用户覆盖 > 主题 tokens：主题之上再叠加一层，供「自定义全局字体/聊天空背景」等个性化
  if (overrides) {
    const root = document.documentElement
    for (const [key, value] of Object.entries(overrides)) {
      // 空串视为「不覆盖」：用户清空输入框时删除该覆盖、回退主题值
      if (value != null && value !== '') root.style.setProperty(key, value)
    }
  }
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
    // 先按 700 加载（Orbitron 可变字体覆盖），仅 400 字重的字体（如 Press Start 2P）回退 400
    void (document as Document).fonts.load(`700 16px "${family}"`).catch(() => {
      void (document as Document).fonts.load(`400 16px "${family}"`).catch(() => {})
    })
  }
}
