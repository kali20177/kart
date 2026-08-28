import { getTheme } from './registry'

/**
 * localStorage settings 里主题字段的迁移 —— main.ts 首帧与 settings store 共用的唯一实现。
 * 1. 旧版 theme（'dark' | 'light'）→ themeId（theme 存在时覆盖 themeId）
 * 2. 二次废弃的 themeMode → themeId（仅当尚无 themeId 时）
 * 3. 未知 themeId（主题被删除/改名）→ 回退默认暗色
 * 原地修改传入对象并返回是否发生变更，是否落盘由调用方决定（main.ts 在 Pinia 初始化前
 * 只读不写；settings store 挂载后会再跑一次——本函数幂等——并落盘）。
 */
export function migrateLegacyThemeFields(p: Record<string, unknown>): boolean {
  let dirty = false
  if (typeof p.theme === 'string') {
    p.themeId = p.theme === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    delete p.theme
    dirty = true
  } else if (typeof p.themeMode === 'string' && typeof p.themeId !== 'string') {
    p.themeId = p.themeMode === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    delete p.themeMode
    dirty = true
  }
  if (typeof p.themeId === 'string' && !getTheme(p.themeId)) {
    p.themeId = 'glass-industrial-dark'
    dirty = true
  }
  return dirty
}
