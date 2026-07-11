import { ref } from 'vue'
import { storage } from './useStorage'

const STORAGE_KEY = 'sendHistory'
const DEFAULT_MAX = 50

// 模块级 ref，确保所有调用方共享同一份状态
const history = ref<string[]>(storage.get<string[]>(STORAGE_KEY, []))
const cursor = ref(-1)
let max = DEFAULT_MAX

/** 发送历史：↑/↓ 翻阅本会话发送过的内容。自动持久化到 localStorage */
export function useSendHistory(maxOverride = DEFAULT_MAX) {
  max = maxOverride

  function add(entry: string) {
    const trimmed = entry
    if (!trimmed) return
    // 去掉与最近一条重复的项
    if (history.value[0] !== trimmed) {
      history.value.unshift(trimmed)
      if (history.value.length > max) history.value.pop()
      persist()
    }
    cursor.value = -1
  }

  function persist() {
    storage.set(STORAGE_KEY, history.value.slice(0, max))
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
    persist()
    if (cursor.value >= idx) cursor.value = Math.max(-1, cursor.value - 1)
  }

  /** 清空全部历史 */
  function clear() {
    history.value = []
    cursor.value = -1
    persist()
  }

  return { history, add, prev, next, reset, remove, clear }
}