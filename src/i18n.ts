import { createI18n } from 'vue-i18n'
import zh from './locales/zh-CN'
import en from './locales/en-US'
import { storage } from './composables/useStorage'

type Locale = 'zh-CN' | 'en-US'

// 编译期结构校验：en 与 zh 必须同形（双向赋值兼容，缺键/多键均报错）。
// 替代原先在 zh-CN.ts 导出的 MessageSchema 显式标注——预编译插件要求 default 导出为对象字面量，
// 无法再对 default 导出做类型标注，故校验移至此处。
const _enMatchesZh: typeof zh = en
const _zhMatchesEn: typeof en = zh
void _enMatchesZh
void _zhMatchesEn

function savedLocale(): Locale {
  const s = storage.get('settings', {}) as { locale?: string } | null
  if (s?.locale === 'en-US' || s?.locale === 'zh-CN') return s.locale
  return 'zh-CN'
}

export const i18n = createI18n<[typeof zh], Locale>({
  legacy: false,
  locale: savedLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zh,
    'en-US': en,
  },
})

export type { Locale }
