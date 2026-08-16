import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { UPDATER_EVENT_CHANNEL } from './Updater'

// ── electron-updater / electron mock ──
// 状态与实例数组都在 vi.hoisted 中定义：hoisted 早于 vi.mock 执行，
// 工厂可引用替身，测试拿到强类型实例（无需 any）。
const { mockAutoUpdater, mockWindows, mockApp, mockShell, MockCancellationToken } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  const mockAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    logger: null as unknown,
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev)!.push(cb)
    }),
    /** 测试触发 electron-updater 事件（驱动 Updater 内部状态机） */
    emit: (ev: string, ...args: unknown[]) => {
      ;(listeners.get(ev) ?? []).forEach((cb) => cb(...args))
    },
    resetListeners: () => listeners.clear(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async (_token?: unknown) => undefined),
    quitAndInstall: vi.fn()
  }

  // 广播目标窗口（apply 时浏览器窗口快照）
  const mockWindows: Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> = []
  const mockApp = { isPackaged: true, getVersion: vi.fn(() => '0.1.0') }
  const mockShell = { openExternal: vi.fn(async () => undefined) }

  // CancellationToken 最小替身（Updater.download 构造 + cancelDownload dispose）
  class MockCancellationToken {
    disposed = false
    dispose() { this.disposed = true }
  }

  return { mockAutoUpdater, mockWindows, mockApp, mockShell, MockCancellationToken }
})

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater, CancellationToken: MockCancellationToken }))
vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: { getAllWindows: () => mockWindows },
  shell: mockShell
}))
vi.mock('./logger', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// 延迟 import：vi.mock 已注册，Updater 模块内 import 命中 mock
import { Updater } from './Updater'

const NEW_INFO = {
  version: '1.1.0',
  releaseDate: '2026-08-16T00:00:00.000Z',
  releaseNotes: '修复若干问题',
  files: [{ size: 100 }, { size: 50 }]
}

function makeWindow(): { webContents: { send: ReturnType<typeof vi.fn> } } {
  return { webContents: { send: vi.fn() } }
}

describe('Updater（主进程单例）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAutoUpdater.resetListeners()
    mockWindows.length = 0
    mockApp.isPackaged = true
    // 默认环境：无 dev/feed 覆盖；APPIMAGE 置为假路径保证「打包 + 非 deb」在
    // 任意平台（含 Linux CI runner）都激活——deb 分支用显式构造参数单独覆盖
    vi.stubEnv('KART_UPDATE_FEED', '')
    vi.stubEnv('KART_UPDATE_DEV', '')
    vi.stubEnv('APPIMAGE', '/tmp/KART.AppImage')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('gate：非打包（isPackaged=false）→ unavailable 且不发起检查', async () => {
    mockApp.isPackaged = false
    const u = new Updater()
    const s = await u.check()
    expect(s.status).toBe('unavailable')
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('gate：Linux 无 APPIMAGE（deb 渠道）→ unavailable', async () => {
    vi.stubEnv('APPIMAGE', '')
    const u = new Updater('linux')
    const s = await u.check()
    expect(s.status).toBe('unavailable')
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('gate：Linux 有 APPIMAGE（AppImage 启动）→ 发起检查', async () => {
    const u = new Updater('linux') // beforeEach 已置 APPIMAGE 假路径
    await u.check()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(u.getState().status).toBe('checking')
  })

  it('激活路径：打包 + 非 deb 渠道 → 发起检查并进入 checking', async () => {
    const u = new Updater()
    const p = u.check()
    expect(u.getState().status).toBe('checking')
    await p
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('构造：KART_UPDATE_FEED → setFeedURL(generic) 覆盖烘焙地址', () => {
    vi.stubEnv('KART_UPDATE_FEED', 'http://127.0.0.1:8765')
    new Updater()
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:8765' })
  })

  it('构造：KART_UPDATE_DEV=1 → forceDevUpdateConfig（dev 本地验证通道）', () => {
    vi.stubEnv('KART_UPDATE_DEV', '1')
    new Updater()
    expect(mockAutoUpdater.forceDevUpdateConfig).toBe(true)
  })

  it('检查中守卫：checking 状态下再次 check 不重复发起', async () => {
    const u = new Updater()
    const p1 = u.check() // 进入 checking（checkForUpdates 挂起中）
    const p2 = u.check()
    await Promise.all([p1, p2])
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('downloaded 守卫：待重启状态下手动复查不重新发起（防「已就绪」被退回「发现新版本」）', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('update-available', NEW_INFO)
    await u.download()
    mockAutoUpdater.emit('update-downloaded', NEW_INFO)
    expect(u.getState().status).toBe('downloaded')

    await u.check() // 守卫直接返回，不查 feed
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(u.getState().status).toBe('downloaded')
  })

  it('取消下载：CancelError → 回到 available（不显示错误），下载传入 CancellationToken', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('update-available', NEW_INFO)
    const cancelErr = Object.assign(new Error('cancelled'), { code: 'ERR_UPDATER_CANCELLED' })
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(cancelErr)

    await u.download()
    expect(u.getState().status).toBe('available')
    expect(u.getState().error).toBeNull()
    expect(u.getState().info?.version).toBe('1.1.0') // 可重新下载
    // 下载请求携带可取消令牌
    expect(mockAutoUpdater.downloadUpdate.mock.calls[0][0]).toBeDefined()
  })

  it('取消下载：非 downloading 状态调用为 no-op', () => {
    const u = new Updater()
    expect(() => u.cancelDownload()).not.toThrow()
  })

  it('取消产生的 error 事件（部分版本会发）被忽略，不覆盖状态', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('update-available', NEW_INFO)
    await u.download()
    const cancelled = Object.assign(new Error('cancelled'), { code: 'ERR_UPDATER_CANCELLED' })
    mockAutoUpdater.emit('error', cancelled)
    expect(u.getState().status).toBe('downloading')
  })

  it('下载失败（非取消）→ error 状态', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('update-available', NEW_INFO)
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('磁盘空间不足'))
    await u.download()
    const s = u.getState()
    expect(s.status).toBe('error')
    expect(s.error).toBe('磁盘空间不足')
  })

  it('完整更新流：check → available → download → progress → downloaded，全程广播契约状态', async () => {
    const u = new Updater()
    const win = makeWindow()
    mockWindows.push(win)

    await u.check() // checking
    mockAutoUpdater.emit('update-available', NEW_INFO)

    let s = u.getState()
    expect(s.status).toBe('available')
    expect(s.info).toEqual({ version: '1.1.0', releaseDate: NEW_INFO.releaseDate, releaseNotes: NEW_INFO.releaseNotes, totalSize: 150 })
    // 契约不含 electron-builder 特有字段
    expect(s.info).not.toHaveProperty('files')

    await u.download()
    s = u.getState()
    expect(s.status).toBe('downloading')

    mockAutoUpdater.emit('download-progress', { percent: 42.666, bytesPerSecond: 1024, transferred: 100, total: 150 })
    expect(u.getState().progress?.percent).toBe(42.7)

    mockAutoUpdater.emit('update-downloaded', NEW_INFO)
    s = u.getState()
    expect(s.status).toBe('downloaded')
    expect(s.progress).toBeNull()

    // 广播：每次状态迁移推送完整快照
    const sends = win.webContents.send.mock.calls.filter((c) => c[0] === UPDATER_EVENT_CHANNEL)
    expect(sends.length).toBeGreaterThanOrEqual(5)
    const last = sends[sends.length - 1][1] as { status: string }
    expect(last.status).toBe('downloaded')
  })

  it('not-available：检查完成无更新 → 终态', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('update-not-available', { version: '0.1.0' })
    expect(u.getState().status).toBe('not-available')
    expect(u.getState().info).toBeNull()
  })

  it('error 事件 → error 状态并透传消息', async () => {
    const u = new Updater()
    await u.check()
    mockAutoUpdater.emit('error', new Error('网络不可达'))
    const s = u.getState()
    expect(s.status).toBe('error')
    expect(s.error).toBe('网络不可达')
    // error 后可从对话窗重试：再次 check 回到 checking
    await u.check()
    expect(u.getState().status).toBe('checking')
  })

  it('download 只在 available 下生效', async () => {
    const u = new Updater()
    await u.download() // idle 状态直接 no-op
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('quitAndInstall：静默 false、安装后拉起 true', () => {
    const u = new Updater()
    u.quitAndInstall()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('openReleases：shell.openExternal 打开 Releases 页', async () => {
    const u = new Updater()
    await u.openReleases()
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://github.com/kali20177/kart/releases/latest')
  })

  it('scheduleStartupCheck：延迟后发起一次检查，重复调用只排程一次', () => {
    vi.useFakeTimers()
    const u = new Updater()
    u.scheduleStartupCheck(5000)
    u.scheduleStartupCheck(5000)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})