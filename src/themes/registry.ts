import type { ThemeDefinition, ThemeTokens, TokenKey } from './types'
import { glassIndustrialDark } from './builtin/glass-industrial-dark'
import { glassIndustrialLight } from './builtin/glass-industrial-light'
import { oledHud } from './builtin/oled-hud'
import { retroConsole } from './builtin/retro-console'

const registry = new Map<string, ThemeDefinition>()

register(glassIndustrialDark)
register(glassIndustrialLight)
register(oledHud)
register(retroConsole)

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

/** 上一轮真正写入过 inline style 的覆盖键集合（非空、被应用过），用于下次清空时移除残留 */
let appliedOverrideKeys = new Set<string>()

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
  const root = document.documentElement
  // 先移除上一轮真正应用过的覆盖键（含被清空的），避免残留旧值：
  // --chat-bg 等只经覆盖写入、不在任何主题 tokens 里的键，清空后必须回落 CSS 默认值。
  for (const key of appliedOverrideKeys) root.style.removeProperty(key)
  appliedOverrideKeys = new Set<string>()

  applyTokens(theme.tokens, theme.isDark)
  root.setAttribute('data-theme-id', theme.id)
  // 用户覆盖 > 主题 tokens：主题之上再叠加一层，供「自定义全局字体/聊天空背景」等个性化
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      // 空串视为「不覆盖」：用户清空输入框时删除该覆盖、回退主题值
      if (value != null && value !== '') {
        root.style.setProperty(key, value)
        appliedOverrideKeys.add(key)
      }
    }
  }
}

/** 当前激活主题（管理字体预加载去重） */
let activeThemeId: string | null = null

/**
 * 应用主题附带字体：预加载 --display-font/--mono-font/--ui-font 三个字体族，
 * 避免 FOIT（首字 fallback → 实际字体闪烁）。字体文件由 styles/fonts.css 的
 * @font-face 声明加载，这里只是提前触发浏览器下载/解析。系统字体族（Inter、JetBrains
 * Mono 等）load 立即命中、无网络开销，自托管字体（Orbitron/Press Start 2P/VT323）才是实际预载。
 */
export function applyFonts(theme: ThemeDefinition): void {
  if (typeof document === 'undefined') return
  if (activeThemeId === theme.id) return
  activeThemeId = theme.id

  // 每个字体 token 取第一个族名（去引号）去重；像素风 ui/mono 同为 VT323 时只加载一次
  const families = new Set<string>()
  for (const key of ['--display-font', '--mono-font', '--ui-font'] as TokenKey[]) {
    const v = theme.tokens[key]
    if (v) families.add(v.split(',')[0].trim().replace(/^['"]|['"]$/g, ''))
  }
  if (typeof (document as Document).fonts?.load !== 'function') return
  for (const family of families) {
    // 先按 700 加载（Orbitron 可变字体做标题常用重字）；仅注册 400 字重的字体
    // （Press Start 2P/VT323）经 CSS font-matching 也会命中同一 400 face 加载，
    // 个别不合成时再显式回退加载 400 兜底。
    void (document as Document).fonts.load(`700 16px "${family}"`).catch(() => {
      void (document as Document).fonts.load(`400 16px "${family}"`).catch(() => {})
    })
  }
}
