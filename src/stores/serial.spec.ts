import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSerialStore } from './serial'

const KEY = 'serial-demo:customBaudRates'

beforeEach(() => {
  setActivePinia(createPinia())
  // 测试环境为 node（vite.config 的 environment:jsdom 未生效），无 localStorage，
  // 用内存实现替代以覆盖持久化逻辑
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.values())[i] ?? null,
    get length() {
      return store.size
    }
  })
})

describe('serial store · 自定义波特率', () => {
  it('预设档位与已存在项不会被重复加入，结果升序持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.addCustomBaudRate(300000)
    s.addCustomBaudRate(74880) // 预设，应忽略
    s.addCustomBaudRate(500000) // 已存在，应忽略
    expect(s.customBaudRates.map((c) => c.baud)).toEqual([300000, 500000])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      { baud: 300000 },
      { baud: 500000 }
    ])
  })

  it('删除自定义波特率并持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.removeCustomBaudRate(500000)
    expect(s.customBaudRates).toEqual([])
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('更新标注，空串/空白清除标注', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.updateCustomBaudNote(500000, '我的设备')
    expect(s.customBaudRates[0].note).toBe('我的设备')
    s.updateCustomBaudNote(500000, '   ')
    expect(s.customBaudRates[0].note).toBeUndefined()
  })

  it('加载时兼容旧版 number[] 格式', () => {
    localStorage.setItem(KEY, JSON.stringify([74880, 500000]))
    const s = useSerialStore()
    expect(s.customBaudRates).toEqual([{ baud: 74880 }, { baud: 500000 }])
  })
})
