import { describe, expect, it, vi, beforeEach } from 'vitest'
import { WARN_THRESHOLD_BYTES, LOCALSTORAGE_LIMIT_BYTES } from './persist'
import { STORAGE_PREFIX } from '@/composables/useStorage'

// persist 模块持有模块级状态（snapshotExported），用 resetModules 保证测试隔离
type PersistApi = typeof import('./persist')
let api: PersistApi

beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  // jsdom 无 URL.createObjectURL，快照导出走浏览器 Blob 分支时 stub 掉
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
  vi.resetModules()
  api = await import('./persist')
})

// jsdom 下 indexedDB 不可用（镜像走 IDB 分支静默降级），localStorage 由 setup.ts stub
// —— 这正好覆盖浏览器无 IDB 时的降级路径；主进程镜像分支由 electron-env 类型守卫跳过。

describe('persistNow', () => {
  it('writes through to localStorage synchronously', () => {
    api.persistNow('settings', { locale: 'en-US' })
    expect(localStorage.getItem(STORAGE_PREFIX + 'settings')).toBe(JSON.stringify({ locale: 'en-US' }))
  })

  it('keeps the same key namespace as storage', () => {
    api.persistNow('commands', [{ id: 'c1' }])
    expect(localStorage.getItem(STORAGE_PREFIX + 'commands')).toBeTruthy()
  })

  it('exposes a sane quota constant', () => {
    expect(LOCALSTORAGE_LIMIT_BYTES).toBe(5 * 1024 * 1024)
  })

  it('triggers snapshot export when usage crosses threshold', async () => {
    const listener = vi.fn()
    const off = api.onSnapshotExport(listener)
    // 构造超大值逼近阈值（约 1.5MB，单次写入即可触发）
    const big = { blob: 'x'.repeat(WARN_THRESHOLD_BYTES) }
    api.persistNow('commands', big)
    // 镜像/导出为异步 fire-and-forget，等待微任务
    await new Promise((r) => setTimeout(r, 20))
    expect(listener).toHaveBeenCalled()
    off()
  })

  it('does not spam snapshot export (once per session)', async () => {
    const listener = vi.fn()
    const off = api.onSnapshotExport(listener)
    const big = { blob: 'x'.repeat(WARN_THRESHOLD_BYTES) }
    api.persistNow('commands', big)
    api.persistNow('settings', big)
    await new Promise((r) => setTimeout(r, 20))
    // 第一个快照导出触发后 snapshotExported=true，第二次调用不再导出
    expect(listener).toHaveBeenCalledTimes(1)
    // 但第二次 persistNow 仍正常写入 localStorage
    expect(localStorage.getItem(STORAGE_PREFIX + 'settings')).toBeTruthy()
    off()
  })
})
