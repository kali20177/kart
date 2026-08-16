import { effectScope, ref, watch } from 'vue'
import { useStorage } from '@vueuse/core'
import { STORAGE_PREFIX } from './useStorage'
import { useSettingsStore } from '@/stores/settings'

const STORAGE_KEY = STORAGE_PREFIX + 'sendHistory'
const FALLBACK_MAX = 50

// 模块级 ref，确保所有调用方共享同一份状态。
// useStorage 返回响应式 ref，变更（含 in-place unshift/splice）自动落盘 localStorage，
// 无需手动 persist。跨标签页亦同步。
const history = useStorage<string[]>(STORAGE_KEY, [])
const cursor = ref(-1)

/** 当前上限：全局设置可配（设置 ▸ 输入 ▸ 发送历史条数上限）；未配置/非法时回退 50 */
function currentMax(): number {
  const limit = useSettingsStore().settings.sendHistoryLimit
  return Number.isInteger(limit) && limit > 0 ? limit : FALLBACK_MAX
}

/** 按当前上限裁剪历史 */
function trim() {
  const m = currentMax()
  if (history.value.length > m) {
    history.value.splice(m)
    history.value = [...history.value]
  }
}

// 上限调低时立即裁剪，避免历史弹窗展示超出设置的条数。
// 用模块级手工 detached effectScope 惰性创建：
//  - 惰性：scope.run 内的 watch 创建时会立即求值一次 getter（拿 oldValue），若放模块顶层，
//    会在 app.use(createPinia()) 之前求值 → useSettingsStore 抛 "no active Pinia"，
//    导致 bundle 在 mount 前崩溃、应用停在加载页。故延迟到首次组件 setup 调用时。
//  - detached（不挂当前组件作用域）：setup 期间创建的 effect 默认随该组件卸载而 stop，
//    首次调用组件一卸载，「调低上限立即裁剪」会永久失效；detached scope 与组件生命周期解耦，
//    与应用同生命周期（模块级状态本来就该如此）。scope 由模块持有、永不 stop。
let trimScope: ReturnType<typeof effectScope> | null = null
function ensureTrimWatch() {
  if (trimScope) return
  const scope = effectScope(true)
  scope.run(() => {
    watch(() => useSettingsStore().settings.sendHistoryLimit, trim)
  })
  trimScope = scope
}

/** 发送历史：↑/↓ 翻阅本会话发送过的内容。自动持久化到 localStorage */
export function useSendHistory() {
  ensureTrimWatch()

  function add(entry: string) {
    const trimmed = entry
    if (!trimmed) return
    // 去掉与最近一条重复的项
    if (history.value[0] !== trimmed) {
      history.value.unshift(trimmed)
      if (history.value.length > currentMax()) history.value.pop()
    }
    cursor.value = -1
  }

  /** 上翻（更早的） */
  function prev(): string | null {
    if (history.value.length === 0) return null
    cursor.value = Math.min(cursor.value + 1, history.value.length - 1)
    return history.value[cursor.value] ?? null
  }

  /** 下翻（更近的）；翻到底返回空串表示回到当前输入 */
  function next(): string | null {
    if (cursor.value <= 0) {
      cursor.value = -1
      return ''
    }
    cursor.value -= 1
    return history.value[cursor.value] ?? null
  }

  function reset() {
    cursor.value = -1
  }

  /** 删除指定索引处的历史条目 */
  function remove(index: number) {
    const idx = Math.max(0, Math.min(history.value.length - 1, index))
    history.value.splice(idx, 1)
    history.value = [...history.value]
    if (cursor.value >= idx) cursor.value = Math.max(-1, cursor.value - 1)
  }

  /** 清空全部历史 */
  function clear() {
    history.value = []
    cursor.value = -1
  }

  return { history, add, prev, next, reset, remove, clear }
}
