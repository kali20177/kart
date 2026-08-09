import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { i18n } from './i18n'
import './styles/base.css'
import './styles/tokens.css'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import '@xterm/xterm/css/xterm.css'
import 'dockview-core/dist/styles/dockview.css'
import './styles/dockview.css'
import { applyTokens, listThemes } from './themes'
import { STORAGE_PREFIX, storage } from './composables/useStorage'
import { logger } from './utils/logger'
import { getDriverType } from './serial'

// 初始化日志系统（尽早，在一切可能产生日志的代码之前）
logger.init('info').then(() => {
  logger.hijackConsole()
  logger.registerGlobalHandlers()

  // 登记环境信息——用户报障时导出的日志文件头会带上这些，省去反复询问
  logger.setEnv('appVersion', __APP_VERSION__)
  logger.setEnv('commit', __GIT_COMMIT__)
  logger.setEnv('buildDate', new Date(__BUILD_DATE__).toISOString())
  logger.setEnv('platform', window.electron?.platform ?? navigator.platform)
  const v = window.electron?.versions
  if (v?.chrome) logger.setEnv('runtime', `electron=${v.electron ?? ''} chrome=${v.chrome} node=${v.node}`)
  // locale 与 i18n.ts 的 savedLocale() 同源，避免 vue-i18n 的 locale ref/值类型二义性
  const savedLocale = (storage.get('settings', {}) as { locale?: string } | null)?.locale
  logger.setEnv('locale', savedLocale ?? 'zh-CN')
  logger.setEnv('screen', `${window.screen?.width ?? '?'}x${window.screen?.height ?? '?'}`)
  logger.setEnv('userAgent', navigator.userAgent)

  const driver = getDriverType()
  logger.setEnv('driver', driver)
  logger.info('app', `boot: KART v${__APP_VERSION__} (${__GIT_COMMIT__}) driver=${driver}`)
})

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
