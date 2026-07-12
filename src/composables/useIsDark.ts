import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/**
 * 是否暗色：settings.theme 为 'dark' 时返回 true。
 * 抽出来供 App.vue 与 WaveformChart 共用 —— uPlot 不吃 CSS 变量，需读 JS 判断决定配色。
 */
export function useIsDark() {
  const settingsStore = useSettingsStore()
  const isDark = computed(() => settingsStore.settings.theme === 'dark')
  return isDark
}
