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
import StatusBar from './StatusBar.vue'
import { provideOpenFileTransfer, provideSession } from '@/composables/useSession'
import { STORAGE_PREFIX } from '@/composables/useStorage'
import type { Session } from '@/session'
import type { DataMode } from '@/types'
import type { AsciiEntry } from '@/utils/ascii-table'

const props = defineProps<{ session: Session }>()

const emit = defineEmits<{
  (e: 'open-file-transfer', file?: File): void
}>()

const session = props.session
provideSession(session)

const { t } = useI18n()

const NAMED_ESCAPES = new Set([0, 9, 10, 13])

// —— dockview 可停靠布局 ——
// 三个面板（消息/波形/终端）作为 dockview 面板注册。面板内容组件经 Teleport
// 保留在 SessionPane 子树中，useSession() 注入依然有效（与 v-show 时代一致）。
const PANEL_IDS = ['messages', 'waveform', 'terminal'] as const
type PanelId = (typeof PANEL_IDS)[number]

const components: Record<string, VueComponent> = {
  messages: MessagePanel as unknown as VueComponent,
  waveform: WaveformChart as unknown as VueComponent,
  terminal: TerminalPane as unknown as VueComponent,
}

const panelTitle = (id: PanelId): string =>
  id === 'messages' ? t('app.msg') : id === 'waveform' ? t('app.waveform') : t('app.terminal')

type SerializedLayout = ReturnType<DockviewApi['toJSON']>

let api: DockviewApi | null = null
/** 当前布局中打开的面板集合（恢复入口菜单勾选状态用） */
const openPanels = ref<Set<PanelId>>(new Set(PANEL_IDS))

const currentPort = computed(() => session.serial.selectedPort ?? '')
const LAYOUT_KEY = (port: string) => STORAGE_PREFIX + 'view-layout:' + (port || 'default')

/** 布局按「当前选中端口」分开持久化：串口 A 调成终端布局、串口 B 调成波形布局互不干扰 */
function loadLayout(port: string): SerializedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY(port))
    return raw ? (JSON.parse(raw) as SerializedLayout) : null
  } catch {
    return null
  }
}

function saveLayout() {
  if (!api) return
  try {
    localStorage.setItem(LAYOUT_KEY(currentPort.value), JSON.stringify(api.toJSON()))
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
  const saved = loadLayout(currentPort.value)
  if (saved) {
    // reuseExistingPanels：同 id 面板复用（组件不重建，xterm/消息列表状态不丢）
    api.fromJSON(saved, { reuseExistingPanels: true })
  } else {
    api.addPanel({ id: 'messages', component: 'messages', title: panelTitle('messages') })
    api.addPanel({ id: 'waveform', component: 'waveform', title: panelTitle('waveform') })
    api.addPanel({ id: 'terminal', component: 'terminal', title: panelTitle('terminal') })
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
  const saved = loadLayout(port)
  if (saved) api.fromJSON(saved, { reuseExistingPanels: true })
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
function onToComposer(p: { text: string; mode: DataMode }) {
  session.composerText = p.text
  session.viewMode = p.mode
}

function onOpenFileTransfer(file?: File) {
  emit('open-file-transfer', file)
}
// 消息面板（dockview 动态渲染，无法走组件 emit 链到本组件）经注入回调触发文件传输对话框
provideOpenFileTransfer(onOpenFileTransfer)

/** 编码器支持的命名转义（与 encodeWithEscapes 的 switch 保持一致） */
function insertAscii(e: AsciiEntry) {
  if (session.viewMode === 'hex') {
    session.composerText += (session.composerText && !session.composerText.endsWith(' ') ? ' ' : '') + e.hex + ' '
  } else if (e.char != null) {
    session.composerText += e.char
  } else if (e.escape && NAMED_ESCAPES.has(e.dec)) {
    session.composerText += e.escape
  }
}

defineExpose({ insertAscii, toComposer: onToComposer })
</script>

<template>
  <div class="session-pane">
    <ConnectionBar />
    <div class="main">
      <div class="dock-wrap">
        <DockviewVue
          :components="components"
          :default-renderer="'always'"
          class="dock"
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
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.view-add:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
