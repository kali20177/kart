import { ref } from 'vue'
import { storage } from './useStorage'

const STORAGE_KEY = 'sendHistory'
const DEFAULT_MAX = 50

/** 发送历史：↑/↓ 翻阅本会话发送过的内容。自动持久化到 localStorage */
export function useSendHistory(max = DEFAULT_MAX) {
  const history = ref<string[]>(storage.get<string[]>(STORAGE_KEY, []))
  // cursor: -1 表示不在历史浏览态（停在当前输入）
  const cursor = ref(-1)

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

  return { history, add, prev, next, reset }
}
