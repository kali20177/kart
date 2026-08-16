import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import type { Logger, ProgressInfo, UpdateInfo } from 'electron-updater'
import { createUpdaterState, isUpdaterActive, updaterReducer } from '../utils/updater'
import type { UpdaterEvent, UpdaterState } from '../utils/updater'
import { mainLogger } from './logger'

// 渲染端订阅 updater 状态推送的事件名（preload 与此保持一致）
export const UPDATER_EVENT_CHANNEL = 'updater:event'

// electron-updater Logger 接口是单参数调用，mainLogger 是 (context, message)——
// 主进程日志出口统一走 mainLogger（用户「导出日志」的数据源）
const updaterLogger: Logger = {
  info: (m) => mainLogger.info('updater', String(m)),
  warn: (m) => mainLogger.warn('updater', String(m)),
  error: (m) => mainLogger.error('updater', String(m)),
  debug: (m) => mainLogger.debug('updater', String(m))
}

// 手动下载兜底地址（与 electron-builder github provider 的仓库一致；换仓库需同步两处）
const RELEASES_URL = 'https://github.com/kali20177/kart/releases/latest'

/** electron-updater 取消下载时 reject 的错误码（builder-util-runtime CancelError） */
const CANCELLED_CODE = 'ERR_UPDATER_CANCELLED'

/**
 * 应用自升级单例（electron-updater 封装）。
 *
 * 契约（渲染端无关后端，见 docs/upgrade-design.md §15）：
 * - 状态经 `updater:event` 推送完整快照（UpdaterState），渲染端只消费该形态；
 * - 动作：check / download / cancelDownload / quitAndInstall / openReleases；
 * - autoDownload=false：下载需用户在对话框显式确认；
 * - autoInstallOnAppQuit=true：「稍后」的语义=下次自然退出时静默安装，绝不主动重启。
 *
 * 本地验证钩子（不打包即可测全链路，见 docs/upgrade-design.md §十一）：
 * - 打包构建：KART_UPDATE_FEED 环境变量 → setFeedURL(generic) 覆盖烘焙地址；
 * - electron:dev：KART_UPDATE_DEV=1 → forceDevUpdateConfig 读仓库根 dev-app-update.yml。
 */
export class Updater {
  private state: UpdaterState = createUpdaterState()
  private startupCheckScheduled = false
  private cancelToken: CancellationToken | null = null

  /**
   * @param platform 平台注入（默认为运行平台）——Linux deb 渠道判定在测试中
   *                 需要显式指定平台；生产路径恒为 process.platform。
   */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {
    // 下载需用户确认；安装只在「立即重启」或自然退出时进行
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = updaterLogger

    const feed = process.env.KART_UPDATE_FEED
    const devEnabled = process.env.KART_UPDATE_DEV === '1'
    if (feed) {
      // 本地 e2e：指向本地 http 服务器（serve release/ 目录），无需真实网络
      autoUpdater.setFeedURL({ provider: 'generic', url: feed })
      mainLogger.info('updater', `feed override: ${feed}`)
    } else if (devEnabled) {
      // dev 模式读项目根 dev-app-update.yml（electron-updater 官方本地测试通道）
      autoUpdater.forceDevUpdateConfig = true
    }

    this.wireEvents()
  }

  /** 当前状态快照（渲染端挂载时同步用，防事件早于订阅丢失） */
  getState(): UpdaterState {
    return { ...this.state }
  }

  /**
   * 启动后延迟静默检查：有更新才推事件（渲染端弹窗），无更新不打扰。
   * 只排程一次；进行中/下载中由 check 的守卫拦截。
   */
  scheduleStartupCheck(delayMs = 5000): void {
    if (this.startupCheckScheduled) return
    this.startupCheckScheduled = true
    setTimeout(() => {
      void this.check()
    }, delayMs)
  }

  /** 检查更新。进行中（checking/downloading）或已就绪待重启（downloaded）直接返回当前状态，不重复发起。 */
  async check(): Promise<UpdaterState> {
    if (!this.isActive()) {
      this.apply({ type: 'unavailable' })
      return this.getState()
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return this.getState()
    }
    this.apply({ type: 'check-start' })
    try {
      mainLogger.info('updater', `checking for updates (current v${app.getVersion()})`)
      await autoUpdater.checkForUpdates()
      // 后续状态由 update-available / update-not-available / error 事件驱动
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      mainLogger.error('updater', `check failed: ${message}`)
      this.apply({ type: 'error', message })
    }
    return this.getState()
  }

  /** 开始下载（仅 available 状态可进入）。完成/失败/取消由事件驱动状态。 */
  async download(): Promise<UpdaterState> {
    if (this.state.status !== 'available') return this.getState()
    this.apply({ type: 'download-start' })
    this.cancelToken = new CancellationToken()
    try {
      mainLogger.info('updater', `downloading v${this.state.info?.version ?? '?'}`)
      await autoUpdater.downloadUpdate(this.cancelToken)
    } catch (e) {
      // 用户主动取消：回到「发现新版本」，可重新下载；不显示错误对话框
      if (isCancelledError(e)) {
        mainLogger.info('updater', 'download cancelled by user')
        this.apply({ type: 'cancel' })
        return this.getState()
      }
      const message = e instanceof Error ? e.message : String(e)
      mainLogger.error('updater', `download failed: ${message}`)
      this.apply({ type: 'error', message })
    } finally {
      this.cancelToken = null
    }
    return this.getState()
  }

  /** 取消进行中的下载：downloadUpdate 以 CancelError reject，状态回到 available */
  cancelDownload(): void {
    if (this.state.status !== 'downloading' || !this.cancelToken) return
    this.cancelToken.dispose()
  }

  /**
   * 退出并安装。isSilent=false 让 Windows NSIS 弹出安装进度（用户可见），
   * isForceRunAfter=true 安装完成后重新拉起应用。
   * 渲染端 UpdateDialog 在调用前已做过录制/下发活跃的二次确认（见 useUpdater）。
   */
  quitAndInstall(): void {
    mainLogger.info('updater', 'quit and install triggered by user')
    autoUpdater.quitAndInstall(false, true)
  }

  /** 手动下载兜底：打开 GitHub Releases 页（macOS 无签名 / deb 渠道等场景） */
  async openReleases(): Promise<void> {
    mainLogger.info('updater', `open releases page: ${RELEASES_URL}`)
    await shell.openExternal(RELEASES_URL)
  }

  // ─── 内部 ───

  private isActive(): boolean {
    return isUpdaterActive({
      isPackaged: app.isPackaged,
      devEnabled: process.env.KART_UPDATE_DEV === '1',
      platform: this.platform,
      appImage: !!process.env.APPIMAGE
    })
  }

  private wireEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.apply({ type: 'checking' })
    })
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      mainLogger.info('updater', `update available: v${info.version}`)
      this.apply({ type: 'available', info: toRawInfo(info) })
    })
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      mainLogger.info('updater', `no update (latest v${info.version})`)
      this.apply({ type: 'not-available' })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.apply({
        type: 'progress',
        progress: {
          percent: Math.round(progress.percent * 10) / 10,
          bytesPerSecond: progress.bytesPerSecond,
          transferred: progress.transferred,
          total: progress.total
        }
      })
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      mainLogger.info('updater', `update downloaded: v${info.version}`)
      this.apply({ type: 'downloaded', info: toRawInfo(info) })
    })
    autoUpdater.on('error', (err: Error) => {
      // 用户主动取消下载也会以 error 走一遍（部分版本）；已由 download() 的
      // CancelError 分支处理成功态，这里只记日志不覆盖状态
      if (isCancelledError(err)) {
        mainLogger.debug('updater', 'ignore cancelled error event')
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      mainLogger.error('updater', `autoUpdater error: ${message}`)
      this.apply({ type: 'error', message })
    })
  }

  /** 走状态机并广播给所有窗口（渲染端订阅 updater:event） */
  private apply(ev: UpdaterEvent): void {
    this.state = updaterReducer(this.state, ev)
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(UPDATER_EVENT_CHANNEL, this.state)
      } catch {
        // 窗口销毁竞态：发送失败忽略
      }
    }
  }
}

/** electron-updater 取消下载时 reject 的错误（builder-util-runtime CancelError） */
function isCancelledError(e: unknown): boolean {
  return e instanceof Error && (e as Error & { code?: string }).code === CANCELLED_CODE
}

/** 原始 UpdateInfo → 契约最小结构（files 仅保留 size，避免泄漏 url/sha512 等）。
 *  releaseNotes 可能是字符串（markdown）或 ReleaseNoteInfo[]（数组），统一为纯文本。 */
function toRawInfo(info: UpdateInfo): { version: string; releaseDate?: string; releaseNotes?: string; files?: Array<{ size?: number }> } {
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => (n.version ? `### v${n.version}\n${n.note}` : n.note)).join('\n\n')
    : (info.releaseNotes ?? undefined)
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: notes,
    files: info.files?.map((f) => ({ size: f.size }))
  }
}