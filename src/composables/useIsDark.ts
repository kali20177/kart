import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/**
 * 是否暗色：settings.theme 为 'system' 时跟随 prefers-color-scheme 媒体查询。
 * 抽出来供 App.vue 与 WaveformChart 共用 —— uPlot 不吃 CSS 变量，需读 JS 判断决定配色。
 */
export function useIsDark() {
  const settingsStore = useSettingsStore()
  const prefersDark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const isDark = computed(() => {
    const t = settingsStore.settings.theme
    if (t === 'system') return prefersDark?.matches ?? true
    return t === 'dark'
  })
  return isDark
}
