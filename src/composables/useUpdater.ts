import { shallowRef } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { createUpdaterState } from '@/utils/updater'
import type { UpdaterState } from '@/utils/updater'

/**
 * 应用自升级 UI 状态（模块级单例）。
 *
 * MenuBar（菜单触发）与 UpdateDialog（状态展示）共享同一实例；updater 状态
 * 是瞬态（不落盘），与 persist/settings 无交集，无需 Pinia。
 *
 * 事件/返回值分工：
 * - 主进程 `updater:event` 推送完整快照 → 持续同步状态 + 弹窗时机
 *   （available/downloaded 才打扰；自动检查的无更新/失败保持静默）；
 * - 手动检查的离散结果（已是最新 / 失败 / 桌面版不可用）走 check() 返回值提示，
 *   避免自动检查的无更新也弹 toast。
 */
const state = shallowRef<UpdaterState>(createUpdaterState())
const dialogVisible = shallowRef(false)
let subscribed = false

export function useUpdater() {
  const message = useMessage()
  const { t } = useI18n()

  if (!subscribed) {
    subscribed = true
    const bridge = window.electron?.updater
    if (bridge) {
      // 挂载时先同步一次快照，防启动自动检查的事件早于订阅丢失
      void bridge.getState().then((s) => { state.value = s })
      bridge.onState((s) => {
        state.value = s
        if (s.status === 'available' || s.status === 'downloaded') {
          dialogVisible.value = true
        }
        // not-available / error / unavailable：自动检查路径静默（手动路径在 check() 内提示）
      })
    }
  }

  /** 手动检查：离散结果（已是最新/失败/桌面版不可用）在此提示 */
  async function check(): Promise<void> {
    const bridge = window.electron?.updater
    if (!bridge) {
      state.value = { ...state.value, status: 'unavailable' }
      return
    }
    const s = await bridge.check()
    state.value = s
    if (s.status === 'not-available') message.info(t('update.latest'))
    else if (s.status === 'error') dialogVisible.value = true
    else if (s.status === 'unavailable') message.info(t('update.unavailable'))
    // downloaded：主进程守卫直接返回「已就绪」——重新弹窗让用户能看到重启安装入口
    else if (s.status === 'downloaded') dialogVisible.value = true
  }

  /** 开始下载（退出按钮置于 available 态对话框） */
  async function download(): Promise<void> {
    const bridge = window.electron?.updater
    if (bridge) state.value = await bridge.download()
  }

  /** 取消进行中的下载（主进程回 available 经 updater:event 同步状态） */
  async function cancelDownload(): Promise<void> {
    await window.electron?.updater?.cancelDownload()
  }

  /** 退出并安装（调用方须先确认录制/下发风险） */
  function quitAndInstall(): void {
    window.electron?.updater?.quitAndInstall()
  }

  /** 手动下载兜底：系统浏览器打开 GitHub Releases 页 */
  async function openReleases(): Promise<void> {
    await window.electron?.updater?.openReleases()
  }

  /** 关闭对话框（下载中关闭=后台继续，完成后事件会再次弹窗） */
  function closeDialog(): void {
    dialogVisible.value = false
  }

  return { state, dialogVisible, check, download, cancelDownload, quitAndInstall, openReleases, closeDialog }
}