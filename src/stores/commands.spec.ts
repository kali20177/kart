import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommandsStore } from './commands'

beforeEach(() => { setActivePinia(createPinia()) })

describe('commands store：占位符 {seq} 计数器', () => {
  it('nextSeq 每命令独立自增', () => {
    const store = useCommandsStore()
    expect(store.nextSeq('a')).toBe(1)
    expect(store.nextSeq('a')).toBe(2)
    expect(store.nextSeq('b')).toBe(1) // 各命令独立计数
    expect(store.nextSeq('a')).toBe(3)
  })

  it('remove 后计数器归零', () => {
    const store = useCommandsStore()
    // 内置 PRESETS 首项 id 为 p1
    store.nextSeq('p1')
    store.nextSeq('p1')
    store.remove('p1')
    expect(store.nextSeq('p1')).toBe(1)
    expect(store.commands.some((c) => c.id === 'p1')).toBe(false)
  })
})