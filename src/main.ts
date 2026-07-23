import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { i18n } from './i18n'
import './styles/base.css'
import './styles/tokens.css'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { applyTokens, listThemes } from './themes'
import { STORAGE_PREFIX } from './composables/useStorage'

// 首帧：同步应用 CSS 变量，避免闪烁。
// Pinia 此时尚未初始化，直接用 localStorage 读持久化的 themeId。
const STORAGE_KEY = STORAGE_PREFIX + 'settings'
let initialThemeId = 'glass-industrial-dark'
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.themeId && typeof parsed.themeId === 'string') {
      initialThemeId = parsed.themeId
    }
    // 迁移旧版 theme → themeId
    if (parsed.theme && typeof parsed.theme === 'string') {
      initialThemeId = parsed.theme === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    }
  }
} catch {
  /* 静默降级 */
}
const initialTheme = listThemes().find(t => t.id === initialThemeId) ?? listThemes()[0]
applyTokens(initialTheme.tokens, initialTheme.isDark)

createApp(App).use(createPinia()).use(i18n).mount('#app')
