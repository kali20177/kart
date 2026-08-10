<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useStorage, useEventListener, useTitle } from '@vueuse/core'
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN, enUS, dateEnUS } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { DockviewVue, type DockviewReadyEvent, type DockviewApi, type VueComponent } from 'dockview-vue'
import MenuBar from './components/MenuBar.vue'
import SessionPanel from './components/SessionPanel.vue'
import SessionTab from './components/SessionTab.vue'
import QuickCommandsPanel from './components/QuickCommandsPanel.vue'
import AsciiTable from './components/AsciiTable.vue'
import SettingsModal from './components/SettingsModal.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import IncompatibleBrowser from './components/IncompatibleBrowser.vue'
import { useTheme } from './composables/useTheme'
import {
  provideActiveSession,
  provideOccupiedPorts,
  provideOpenFileTransferHandler,
  provideSessions,
} from './composables/useSession'
import { createSession } from './session'
import { STORAGE_PREFIX } from './composables/useStorage'
import { applyAsciiInsert, setComposer } from './utils/composer'
import type { Session } from './session'
import type { AsciiEntry } from './utils/ascii-table'
import type { DataMode } from './types'

// 多会话：每个会话一个 Session（独立驱动 + 独立 store 六件套），settings 为全局共享
// （session/index.ts L57 注入同一 proxy）。会话面板挂在根级 dockview 上，可拖动停靠
// 并排显示——两个串口的数据流即可同屏对比。
const sessions = ref<Session[]>([])
const activeSessionId = ref(0)
const activeSession = computed(() => sessions.value[activeSessionId.value])

// 初始建第 1 个会话（单会话默认行为，与改造前一致）
sessions.value.push(createSession())
// 传 ref/computed 本身（非 .value）：provide 只执行一次，传解包值会固定为会话 0
provideActiveSession(activeSession)
// 被其他会话已连接占用的端口集合（各 ConnectionBar 下拉禁用提示）
provideOccupiedPorts(
  computed(() => new Set(sessions.value.filter((s) => s.serial.connected).map((s) => s.serial.selectedPort).filter((p): p is string => !!p)))
)
// 会话列表注入（SessionTab 用：数量→末会话不可关闭、序号→默认标题）
provideSessions(sessions)

// —— 根级 dockview：会话面板可拖动停靠（并排对比双串口） ——
// 面板 id = `session:<id>`；内容组件 SessionPanel 经 params 拿到会话；tab 组件 SessionTab
// 自渲染标题/连接点/关闭按钮，无需 App 侧同步标题。会话列表不跨重启持久化（与会话本身一致）。
const components: Record<string, VueComponent> = {
  session: SessionPanel as unknown as VueComponent,
}
/** 会话 tab 组件（自定义 tab：标题/连接点/末会话不可关闭）。default-tab-component 类型为 VueComponent，需 cast */
const sessionTabComponent = SessionTab as unknown as VueComponent

let dockApi: DockviewApi | null = null
const SESSION_PANEL = (id: number) => `session:${id}`

function onDockReady(event: DockviewReadyEvent) {
  dockApi = event.api
  ensureSessionPanel(sessions.value[0])
  // 活动会话 = 当前聚焦面板（拖成并排后用户聚焦哪个会话，全局操作就作用于哪个会话）
  event.api.onDidActivePanelChange(({ panel }) => {
    const idx = panel ? sessions.value.findIndex((s) => SESSION_PANEL(s.id) === panel.id) : -1
    if (idx >= 0) activeSessionId.value = idx
  })
  // 面板关闭（tab ×）→ 销毁会话；末会话保护见 removeSession
  event.api.onDidRemovePanel((panel) => {
    removeSession(panel.id)
  })
}

function ensureSessionPanel(s: Session) {
  if (!dockApi || dockApi.getPanel(SESSION_PANEL(s.id))) return
  dockApi.addPanel({
    id: SESSION_PANEL(s.id),
    component: 'session',
    title: s.serial.selectedPort ?? t('session.tabLabel', { n: sessions.value.length }),
    params: s,
  })
}

function onNewSession() {
  const s = createSession()
  sessions.value.push(s)
  ensureSessionPanel(s) // addPanel 会激活新面板 → onDidActivePanelChange → activeSessionId 跟随
  // 新会话独立驱动，端口列表为空，需主动拉取一次（初始会话在 onMounted 拉取）
  s.serial.refreshPorts()
}

function removeSession(panelId: string) {
  const idx = sessions.value.findIndex((s) => SESSION_PANEL(s.id) === panelId)
  if (idx === -1) return
  const [s] = sessions.value.splice(idx, 1)
  s.dispose()
  // 末会话保护：dockview 无 closable 开关，靠 SessionTab 不渲染 ×（UI 层拦截）；
  // 其他路径（如未来代码调用 close）关掉最后一个时立即补一个新会话，保证至少 1 个
  if (sessions.value.length === 0) {
    const ns = createSession()
    sessions.value.push(ns)
    ensureSessionPanel(ns)
    ns.serial.refreshPorts()
  } else if (activeSessionId.value >= sessions.value.length) {
    activeSessionId.value = sessions.value.length - 1
  }
}

// —— 对话框 opener 会话绑定 ——
// 对话框由会话内组件（ConnectionBar/InputComposer）触发但渲染在根层；触发时记录
// 触发会话，之后切 tab/聚焦不影响已打开的对话框。无触发记录时回落活动会话。
const showAscii = ref(false)
const showSettings = ref(false)
const showFileTransfer = ref(false)
const fileTransferDropFile = ref<File | null>(null)
const openerSession = ref<Session | null>(null)
function onOpenSettings() {
  openerSession.value = activeSession.value
  showSettings.value = true
}
function onOpenFileTransfer(session: Session, file?: File) {
  openerSession.value = session
  fileTransferDropFile.value = file ?? null
  showFileTransfer.value = true
}
// SessionPane 在 dockview 面板内无法 emit 到本组件，文件传输对话框经此注入回调触发
provideOpenFileTransferHandler(onOpenFileTransfer)

// ASCII 编码器插入 / 快速命令「调到发送框」：直接操作活动会话的 composerText
// （发送框草稿本就是会话状态，dockview 动态渲染下不再走组件 ref 链）
function onInsertAscii(entry: AsciiEntry) {
  if (activeSession.value) applyAsciiInsert(activeSession.value, entry)
}
function onToComposer(p: { text: string; mode: DataMode }) {
  if (activeSession.value) setComposer(activeSession.value, p.text, p.mode)
}

const commandsCollapsed = ref(false)

// —— 快速命令侧边栏宽度拖拽 ——
// 手柄在侧边栏左边缘：向左拖增大、向右拖减小。
const COL_MIN = 200
const COL_MAX = 480
const DEFAULT_RIGHT_WIDTH = 200
const rightWidth = useStorage(STORAGE_PREFIX + 'app:rightWidth', DEFAULT_RIGHT_WIDTH)
const dragging = ref(false)
const rightStyle = computed(() =>
  commandsCollapsed.value ? {} : { width: rightWidth.value + 'px' }
)
let colDragStartX = 0
let colDragStartW = 0
let stopColMove: (() => void) | null = null

function onColGripDown(e: PointerEvent) {
  if (commandsCollapsed.value) return
  e.preventDefault()
  dragging.value = true
  colDragStartX = e.clientX
  colDragStartW = rightWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  // 拖拽期间动态注册，pointerup 时通过返回的 cleanup 解绑
  stopColMove = useEventListener(window, 'pointermove', onColGripMove)
  useEventListener(window, 'pointerup', onColGripUp, { once: true })
}

function onColGripMove(e: PointerEvent) {
  // grip 在左边缘：向左拖（delta 为负）增大宽度
  let w = colDragStartW - (e.clientX - colDragStartX)
  w = Math.max(COL_MIN, Math.min(COL_MAX, w))
  rightWidth.value = w
}

function onColGripUp() {
  dragging.value = false
  stopColMove?.()
  stopColMove = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  // rightWidth 为 useStorage 响应式 ref，变更自动落盘
}

/** 「恢复默认设置」时就地重置侧边栏宽度 */
function onResetLayout() {
  rightWidth.value = DEFAULT_RIGHT_WIDTH
}

// setup 期注册，组件卸载时 useEventListener 自动解绑
useEventListener(window, 'app:reset-layout', onResetLayout)

onBeforeUnmount(() => {
  // 兜底：拖拽进行中卸载时清理 pointermove（根组件实际不会卸载）
  stopColMove?.()
})

// —— i18n / 主题 / 语言 ——
const { t, locale } = useI18n()
const title = useTitle()
const { naiveTheme, naiveOverrides } = useTheme()

// 语言切换：同步 settings → vue-i18n + html lang
watch(
  () => sessions.value[0]?.settings.locale,
  (l) => {
    if (!l) return
    locale.value = l
    document.documentElement.setAttribute('lang', l === 'zh-CN' ? 'zh-CN' : 'en')
    title.value = t('app.name')
  },
  { immediate: true }
)

// Naive UI 语言包
const naiveLocale = computed(() => (sessions.value[0]?.settings.locale === 'zh-CN' ? zhCN : enUS))
const naiveDateLocale = computed(() => (sessions.value[0]?.settings.locale === 'zh-CN' ? dateZhCN : dateEnUS))

// 全局字体大小（会话共享设置，任一会话生效即同步全部）
watch(
  () => sessions.value[0]?.settings.fontSize,
  (px) => {
    if (px) document.documentElement.style.setProperty('--bubble-font-size', px + 'px')
  },
  { immediate: true }
)

onMounted(() => {
  activeSession.value?.serial.refreshPorts()
})
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="naiveOverrides" :locale="naiveLocale" :date-locale="naiveDateLocale">
    <NMessageProvider>
      <NDialogProvider>
      <div class="app">
        <IncompatibleBrowser
          v-if="sessions.some((s) => s.serial.driverType === 'unsupported')"
          :reason="sessions.find((s) => s.serial.driverType === 'unsupported')!.serial.unsupportedReason"
        />
        <MenuBar>
          <!-- 全局功能按钮并进菜单栏行（不额外占行高，dock 区域不下沉） -->
          <button class="global-btn ascii-btn" @click="showAscii = true" :title="t('conn.asciiTable')">ASCII</button>
          <button class="global-btn icon-btn" @click="onOpenSettings" :title="t('conn.settings')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="8" cy="8" r="4.4" />
              <circle cx="8" cy="8" r="1.6" />
              <path d="M12.4 9.1L14.4 9.1L14.4 6.9L12.4 6.9ZM10.3 11.9L11.7 13.3L13.3 11.7L11.9 10.3ZM6.9 12.4L6.9 14.4L9.1 14.4L9.1 12.4ZM4.1 10.3L2.7 11.7L4.3 13.3L5.7 11.9ZM3.6 6.9L1.6 6.9L1.6 9.1L3.6 9.1ZM5.7 4.1L4.3 2.7L2.7 4.3L4.1 5.7ZM9.1 3.6L9.1 1.6L6.9 1.6L6.9 3.6ZM11.9 5.7L13.3 4.3L11.7 2.7L10.3 4.1Z" />
            </svg>
          </button>
        </MenuBar>

        <div class="main">
          <div class="dock-wrap">
            <DockviewVue
              :components="components"
              :default-tab-component="sessionTabComponent"
              :default-renderer="'always'"
              class="dock"
              @ready="onDockReady"
            />
            <!-- 新建会话入口：悬浮在 dockview 右上角（tab 栏右侧留白处） -->
            <button class="session-add" :title="t('session.new')" @click="onNewSession">＋</button>
          </div>

          <div
            class="right"
            :class="{ collapsed: commandsCollapsed, dragging }"
            :style="rightStyle"
          >
            <div
              v-if="!commandsCollapsed"
              class="col-grip"
              @pointerdown="onColGripDown"
              title="拖动调整宽度"
            />
            <button class="collapse-tab" @click="commandsCollapsed = !commandsCollapsed">
              {{ commandsCollapsed ? '‹' : '›' }}
            </button>
            <QuickCommandsPanel v-show="!commandsCollapsed" @to-composer="onToComposer" />
          </div>
        </div>
      </div>

      <AsciiTable v-model:show="showAscii" @insert="onInsertAscii" />
      <SettingsModal v-model:show="showSettings" :session="openerSession ?? activeSession" />
      <FileTransferDialog
        v-model:show="showFileTransfer"
        :drop-file="fileTransferDropFile"
        :session="openerSession ?? activeSession"
        @started="showFileTransfer = false"
      />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
/* 全局功能按钮样式（经 MenuBar 右侧插槽渲染，复用菜单栏行不占额外行高） */
.global-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color 0.15s, background 0.15s;
}
.icon-btn {
  width: 24px;
  height: 24px;
  padding: 0;
}
.icon-btn svg {
  width: 15px;
  height: 15px;
}
.ascii-btn {
  height: 24px;
  padding: 0 8px;
  font-family: var(--mono-font);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.global-btn:hover {
  color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
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
/* 新建会话入口：悬浮在 dockview 右上角（tab 栏右侧留白处） */
.session-add {
  position: absolute;
  top: 6px;
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
.session-add:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.right {
  flex: none;
  width: 240px;
  position: relative;
  transition: width 0.18s;
}
.right.dragging {
  transition: none;
}
.right.collapsed {
  width: 16px;
}
.right {
  box-shadow: var(--shadow-lg);
  z-index: 1;
}
/* 侧边栏左边缘横向拖拽手柄：向左拖增大、向右拖减小 */
.col-grip {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
}
.col-grip::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  width: 2px;
  background: var(--border);
  transition: background 0.15s;
}
.col-grip:hover::before {
  background: var(--accent);
}
.collapse-tab {
  position: absolute;
  left: -1px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 16px;
  height: 48px;
  border: 1px solid var(--border);
  border-left: none;
  background: var(--bg-panel);
  color: var(--text-dim);
  cursor: pointer;
  border-radius: 0 var(--radius) var(--radius) 0;
}
</style>
