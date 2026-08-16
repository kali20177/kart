import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '@/stores/settings'

// useSendHistory 持有模块级单例（history/cursor/watch），跨用例会残留，
// 故每个用例前 resetModules + 动态 import 重新求值模块。
type HistoryModule = typeof import('./useSendHistory')
let sendHistory: HistoryModule

beforeEach(async () => {
  vi.resetModules()
  setActivePinia(createPinia())
  sendHistory = await import('./useSendHistory')
})

describe('useSendHistory', () => {
  it('默认上限来自全局设置（50），超出后按 FIFO 裁剪', () => {
    const h = sendHistory.useSendHistory()
    for (let i = 0; i < 55; i++) h.add(`cmd-${i}`)
    expect(h.history.value).toHaveLength(50)
    // 最新发送的在最前
    expect(h.history.value[0]).toBe('cmd-54')
    expect(h.history.value[49]).toBe('cmd-5')
  })

  it('设置调低上限后，新增按新上限裁剪', () => {
    useSettingsStore().settings.sendHistoryLimit = 3
    const h = sendHistory.useSendHistory()
    for (let i = 0; i < 5; i++) h.add(`cmd-${i}`)
    expect(h.history.value).toEqual(['cmd-4', 'cmd-3', 'cmd-2'])
  })

  it('上限调低时立即裁剪已有历史', async () => {
    const h = sendHistory.useSendHistory()
    for (let i = 0; i < 3; i++) h.add(`cmd-${i}`)
    expect(h.history.value).toHaveLength(3)
    useSettingsStore().settings.sendHistoryLimit = 2
    await nextTick()
    expect(h.history.value).toEqual(['cmd-2', 'cmd-1'])
  })

  it('与最近一条重复的发送不新增', () => {
    const h = sendHistory.useSendHistory()
    h.add('same')
    h.add('same')
    expect(h.history.value).toEqual(['same'])
  })

  it('模块 import 不依赖激活的 pinia（无模块顶层 store 调用）', async () => {
    // 应用加载时 main.ts 的 import 链先于 app.use(createPinia()) 求值模块，
    // 模块顶层若有 watch(() => useStore()...) 会立即求值 getter 并抛错，
    // 导致 bundle 在 mount 前崩溃、应用停在加载页。此处清空 active pinia 验证。
    setActivePinia(undefined as never)
    vi.resetModules()
    await expect(import('./useSendHistory')).resolves.toBeDefined()
  })

  it('上限 watch 不随首个调用组件卸载而失效', async () => {
    // setup 期间创建的 watch 默认挂组件作用域，组件卸载即停；上限裁剪须与应用同生命周期，
    // 故 useSendHistory 用 detached effectScope 隔离——首个调用组件卸载后调低上限仍应立即裁剪。
    const Host = defineComponent({
      setup() {
        sendHistory.useSendHistory()
        return () => null
      },
    })
    const wrapper = mount(Host, { attachTo: document.body })
    const h = sendHistory.useSendHistory()
    for (let i = 0; i < 3; i++) h.add(`cmd-${i}`)
    wrapper.unmount()
    document.body.innerHTML = ''

    useSettingsStore().settings.sendHistoryLimit = 2
    await nextTick()
    expect(h.history.value).toEqual(['cmd-2', 'cmd-1'])
  })
})