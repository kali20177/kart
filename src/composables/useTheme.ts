import { computed, watch } from 'vue'
import { darkTheme } from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import { getTheme, applyTheme as applyThemeTokens, applyFonts as applyThemeFonts, listThemes } from '@/themes'
import type { ThemeDefinition } from '@/themes'

export function useTheme() {
  const settingsStore = useSettingsStore()

  const themeId = computed<string>(() => settingsStore.settings.themeId ?? 'glass-industrial-dark')

  const theme = computed<ThemeDefinition>(() => {
    return getTheme(themeId.value) ?? listThemes()[0]
  })

  const isDark = computed(() => theme.value.isDark)

  const tokens = computed(() => theme.value.tokens)

  const naiveTheme = computed(() => (isDark.value ? darkTheme : null))

  const naiveOverrides = computed(() => theme.value.naiveOverrides)

  // themeId 切换 / 用户覆盖变化 → 应用 CSS 变量 + 主题附带字体。
  // 用户覆盖（settings.themeOverrides）在主题 token 之上叠加，优先级最高，
  // 支持「自定义全局字体 / 聊天空背景」等个性化。
  function applyNow() {
    const t = getTheme(themeId.value) ?? listThemes()[0]
    applyThemeTokens(t, settingsStore.settings.themeOverrides)
    applyThemeFonts(t)
  }
  // 主题切换立即应用（首帧由 main.ts 预应用，此处兜底）；用户覆盖变化合并到每帧一次，
  // 避免字体框内每键入一个字符都全量重写全部 CSS 变量（中间非法字体名还会短暂回退）。
  let overridesQueued = false
  function applyOverridesQueued() {
    if (overridesQueued) return
    overridesQueued = true
    requestAnimationFrame(() => {
      overridesQueued = false
      applyNow()
    })
  }
  watch(() => settingsStore.settings.themeId, applyNow, { immediate: true })
  watch(() => settingsStore.settings.themeOverrides, applyOverridesQueued, { deep: true })

  function setTheme(id: string) {
    settingsStore.settings.themeId = id
  }

  // Dev 调试钩子
  if (import.meta.env.DEV) {
    const w = window as unknown as { __theme?: Record<string, unknown> }
    w.__theme = { setTheme, themeId, isDark, tokens }
  }

  return {
    themeId,
    theme,
    isDark,
    naiveTheme,
    naiveOverrides,
    setTheme,
    listThemes,
  }
}
