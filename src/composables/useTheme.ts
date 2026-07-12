import { computed, watch } from 'vue'
import { darkTheme } from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import { getTheme, applyTokens as applyThemeTokens, listThemes } from '@/themes'
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

  // themeId 切换 → 应用 CSS 变量
  watch(
    () => settingsStore.settings.themeId,
    (id) => {
      const t = getTheme(id) ?? listThemes()[0]
      applyThemeTokens(t.tokens, t.isDark)
    },
    { immediate: true }
  )

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
    isDark,
    naiveTheme,
    naiveOverrides,
    setTheme,
    listThemes,
  }
}
