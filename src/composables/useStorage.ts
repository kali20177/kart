// 持久化封装 —— 阶段 1 走 localStorage；阶段 2 把内部实现换成 electron-store（接口不变）

// 应用命名空间前缀。所有 localStorage 键（含直接调用 useStorage / 原生 localStorage 的
// 调用方）与 IndexedDB 库名、picker id 统一引用此常量拼键；将来改名只需改这一处。
export const STORAGE_PREFIX = 'kart:'

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key)
      if (raw == null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },

  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
    } catch {
      // localStorage 满或被禁用时静默失败，不影响主流程
    }
  },

  remove(key: string): void {
    localStorage.removeItem(STORAGE_PREFIX + key)
  }
}