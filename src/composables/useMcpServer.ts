import { ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/**
 * MCP server 生命周期联动：settings.mcp 配置变化 → 主进程 start/stop。
 * - mode='off'：停止；
 * - 非 off：确保运行；端口/授权模式/静态 token 变化时先停后起（start 幂等）。
 * token 为空 = 随机模式（主进程每次启动生成），不参与重启判定——
 * 「重新生成」按钮显式 stop+start 才换新随机 token。
 * 浏览器构建（无 window.electron.mcp）下全部 no-op。
 */
export function useMcpServer() {
  const settingsStore = useSettingsStore()
  const status = ref<McpBridgeState>({ running: false, port: null, token: null, mode: 'off' })

  const api = () => window.electron?.mcp

  async function sync(): Promise<McpBridgeState> {
    const a = api()
    if (!a) return status.value
    const cfg = settingsStore.settings.mcp
    if (cfg.mode === 'off') {
      status.value = await a.stop()
      return status.value
    }
    const cur = await a.getState()
    const tokenChanged = cfg.token !== '' && cfg.token !== cur.token
    if (cur.running && (cur.port !== cfg.port || cur.mode !== cfg.mode || tokenChanged)) {
      await a.stop()
    }
    status.value = await a.start({ port: cfg.port, token: cfg.token || null, mode: cfg.mode })
    return status.value
  }

  /** 「重新生成 token」：清静态 token 回随机模式并强制重启换新随机值。 */
  async function regenerateToken(): Promise<McpBridgeState> {
    settingsStore.settings.mcp.token = ''
    if (status.value.running) {
      const a = api()
      if (a) await a.stop()
    }
    return await sync()
  }

  // 配置变化（含弹窗内编辑）→ 同步主进程；深度监听避免漏项
  watch(() => settingsStore.settings.mcp, sync, { deep: true })

  return { status, sync, regenerateToken }
}