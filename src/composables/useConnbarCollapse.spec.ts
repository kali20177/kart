import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useConnbarCollapse } from './useConnbarCollapse'
import { createSession } from '@/session'
import { setDriverType } from '@/serial'
import { STORAGE_PREFIX } from './useStorage'

beforeEach(() => {
  setActivePinia(createPinia())
  setDriverType('mock')
})

describe('useConnbarCollapse', () => {
  it('同一会话重复调用返回同一 collapsed ref（ConnectionBar 与 SessionTab 共享状态）', () => {
    const session = createSession()
    const a = useConnbarCollapse(session)
    const b = useConnbarCollapse(session)
    expect(a.collapsed).toBe(b.collapsed)
    session.dispose()
  })

  it('不同会话各自独立状态', () => {
    const s1 = createSession()
    const s2 = createSession()
    const a = useConnbarCollapse(s1)
    const b = useConnbarCollapse(s2)
    a.collapsed.value = true
    expect(b.collapsed.value).toBe(false)
    s1.dispose()
    s2.dispose()
  })

  it('collapsed 变更按当前端口落盘；端口切换重读新端口持久化值', async () => {
    const session = createSession()
    const { collapsed } = useConnbarCollapse(session)

    // 写：收起 → 落盘到当前端口（未选端口=COM3 mock？selectedPort 为 null → 'default'）
    collapsed.value = true
    await nextTick()
    expect(localStorage.getItem(STORAGE_PREFIX + 'connbar:collapsed:default')).toBe('true')

    // 端口切换：重读新端口的持久化值（新端口无记录 → false），旧端口的收起态不带入
    session.serial.selectedPort = '/dev/testA'
    await nextTick()
    expect(collapsed.value).toBe(false)

    // 新端口收起 → 落盘到新端口 key；切回 default 恢复 true
    collapsed.value = true
    await nextTick()
    expect(localStorage.getItem(STORAGE_PREFIX + 'connbar:collapsed:/dev/testA')).toBe('true')
    session.serial.selectedPort = null
    await nextTick()
    expect(collapsed.value).toBe(true)

    session.dispose()
  })
})
