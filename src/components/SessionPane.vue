<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDropdown } from 'naive-ui'
import { useDebounceFn } from '@vueuse/core'
import { DockviewVue, type DockviewReadyEvent, type DockviewApi, type VueComponent } from 'dockview-vue'
import ConnectionBar from './ConnectionBar.vue'
import MessagePanel from './MessagePanel.vue'
import WaveformChart from './WaveformChart.vue'
import TerminalPane from './TerminalPane.vue'
import DashboardPane from './DashboardPane.vue'
import StatusBar from './StatusBar.vue'
import ViewTab from './ViewTab.vue'
import { provideOpenFileTransfer, provideSession, useOpenFileTransferHandler } from '@/composables/useSession'
import { STORAGE_PREFIX } from '@/composables/useStorage'
import type { Session } from '@/session'

const props = defineProps<{ session: Session }>()

const session = props.session
provideSession(session)

const { t } = useI18n()

const openFileTransferHandler = useOpenFileTransferHandler()
// 根级 dockview 的面板内容无法 emit 到 App.vue，改经根注入回调触发文件传输对话框
provideOpenFileTransfer((file?: File) => openFileTransferHandler(session, file))

// —— dockview 可停靠布局 ——
// 四个面板（消息/波形/终端/仪表盘）作为 dockview 面板注册。面板内容组件经 Teleport
// 保留在 SessionPane 子树中，useSession() 注入依然有效（与 v-show 时代一致）。
const PANEL_IDS = ['messages', 'waveform', 'terminal', 'dashboard'] as const
type PanelId = (typeof PANEL_IDS)[number]

const components: Record<string, VueComponent> = {
  messages: MessagePanel as unknown as VueComponent,
  waveform: WaveformChart as unknown as VueComponent,
  terminal: TerminalPane as unknown as VueComponent,
  dashboard: DashboardPane as unknown as VueComponent,
}

/** 视图 tab 组件（自定义 tab：图标 + 视图主题色）。default-tab-component 对
 *  无 tabComponent 字段的旧持久化布局同样生效，老布局切到新视觉无需清缓存 */
const viewTabComponent = ViewTab as unknown as VueComponent

const panelTitle = (id: PanelId): string =>
  id === 'messages' ? t('app.msg') : id === 'waveform' ? t('app.waveform') : id === 'terminal' ? t('app.terminal') : t('app.dashboard')

type SerializedLayout = ReturnType<DockviewApi['toJSON']>

let api: DockviewApi | null = null
/** 当前布局中打开的面板集合（恢复入口菜单勾选状态用） */
const openPanels = ref<Set<PanelId>>(new Set(PANEL_IDS))

const currentPort = computed(() => session.serial.selectedPort ?? '')
// v2：仪表盘不再默认打开（默认三面板），作废 v1 时代保存的含仪表盘 4-tab 布局，回到干净默认。
// 此后的布局（含用户主动打开仪表盘）照常持久化。
const LAYOUT_KEY = (port: string) => STORAGE_PREFIX + 'view-layout:v2:' + (port || 'default')

/** 读取指定端口的持久化布局。JSON 解析失败或结构非法（损坏/跨版本）时清除并返回 null。 */
function loadLayout(port: string): SerializedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY(port))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    // dockview fromJSON 对非法根节点直接抛错，先拦截，避免打挂 dockview
    const rootType = (parsed as { grid?: { root?: { type?: unknown } } }).grid?.root?.type
    if (rootType !== 'branch') {
      // 结构非法：清除坏数据，避免每次重载重复失败
      try { localStorage.removeItem(LAYOUT_KEY(port)) } catch { /* ignore */ }
      return null
    }
    return parsed as SerializedLayout
  } catch {
    return null
  }
}

/** 恢复指定端口布局；成功返回 true，无保存布局或恢复失败（已清除坏数据）返回 false。 */
function restoreLayout(port: string): boolean {
  const saved = loadLayout(port)
  if (!saved || !api) return false
  try {
    // reuseExistingPanels：同 id 面板复用（组件不重建，xterm/消息列表状态不丢）
    api.fromJSON(saved, { reuseExistingPanels: true })
    return true
  } catch {
    try { localStorage.removeItem(LAYOUT_KEY(port)) } catch { /* ignore */ }
    return false
  }
}

/** 面板不存在则创建（fromJSON 失败留下半截状态时也能自愈）。 */
function ensurePanel(id: PanelId) {
  if (api && !api.getPanel(id)) api.addPanel({ id, component: id, title: panelTitle(id) })
}

function saveLayout() {
  if (!api) return
  const port = currentPort.value
  try {
    localStorage.setItem(LAYOUT_KEY(port), JSON.stringify(api.toJSON()))
    // 顺带清理 v1 布局键（无 :v2: 前缀）：升级后不再读取，避免 localStorage 遗留
    try { localStorage.removeItem(STORAGE_PREFIX + 'view-layout:' + (port || 'default')) } catch { /* ignore */ }
  } catch {
    // 存储满等异常忽略（布局非关键数据）
  }
}
const saveLayoutDebounced = useDebounceFn(saveLayout, 400)

function refreshOpenPanels() {
  if (!api) return
  openPanels.value = new Set(PANEL_IDS.filter((id) => api!.getPanel(id)))
}

function onReady(event: DockviewReadyEvent) {
  api = event.api
  if (!restoreLayout(currentPort.value)) {
    // 无保存布局（或坏布局已清除）：建默认三面板（消息/波形/终端），并恢复「消息」为默认活动视图。
    // 仪表盘不默认打开——默认占满视图区过大，按需从「＋」菜单打开。
    // addPanel 会激活最后添加的面板（默认落到终端），须显式切回消息，与旧 view-tabs 默认一致。
    ensurePanel('messages')
    ensurePanel('waveform')
    ensurePanel('terminal')
    api.getPanel('messages')?.api.setActive()
  }
  // 布局/面板变化均落盘：尺寸移动走 onDidLayoutChange，关闭/重开面板走 add/remove
  const scheduleSave = () => {
    refreshOpenPanels()
    saveLayoutDebounced()
  }
  api.onDidLayoutChange(scheduleSave)
  api.onDidAddPanel(scheduleSave)
  api.onDidRemovePanel(scheduleSave)
  refreshOpenPanels()
}

// 会话内切换端口 → 恢复该端口的布局；无保存布局则保持当前（首次连上新端口即继承当前布局）
watch(currentPort, (port) => {
  if (!api) return
  restoreLayout(port)
})

// 会话关闭前落盘最后一次布局（防抖窗口内的改动不丢）
onBeforeUnmount(() => {
  saveLayout()
})

// —— 面板恢复入口：dockview 面板被关闭后可重新打开 / 聚焦 ——
const viewMenuOptions = computed(() =>
  PANEL_IDS.map((id) => ({
    label: `${openPanels.value.has(id) ? '✓' : '＋'} ${panelTitle(id)}`,
    key: id,
  }))
)

function onViewMenuSelect(key: string) {
  if (!api) return
  const id = key as PanelId
  const panel = api.getPanel(id)
  if (panel) {
    panel.api.setActive()
  } else {
    api.addPanel({ id, component: id, title: panelTitle(id) })
  }
}

// —— 发送框联动（发送框在消息面板内，状态存 session.composerText/viewMode） ——
// ASCII 插入 / 快速命令「调到发送框」由 App.vue 直接操作活动会话（utils/composer），不再走组件暴露
</script>

<template>
  <div class="session-pane">
    <ConnectionBar />
    <div class="main">
      <div class="dock-wrap">
        <DockviewVue
          :components="components"
          :default-tab-component="viewTabComponent"
          :default-renderer="'always'"
          class="dock view-dock"
          @ready="onReady"
        />
        <NDropdown trigger="click" :options="viewMenuOptions" @select="onViewMenuSelect">
          <button class="view-add" :title="t('app.addView')">＋</button>
        </NDropdown>
      </div>
    </div>
    <StatusBar />
  </div>
</template>

<style scoped>
.session-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.dock-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* 面板恢复入口：悬浮在 dockview 右上角（tab 栏右侧留白处） */
.view-add {
  position: absolute;
  top: 4px;
  right: 8px;
  z-index: 10;
  appearance: none;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  width: 22px;
  height: 22px;
  /* 字面量「＋」用文本基线排列会偏上，flex 居中保证字形在方框正中 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.view-add:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
