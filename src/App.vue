<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useStorage, useEventListener, useTitle } from '@vueuse/core'
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN, enUS, dateEnUS } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import MenuBar from './components/MenuBar.vue'
import SessionPane from './components/SessionPane.vue'
import QuickCommandsPanel from './components/QuickCommandsPanel.vue'
import AsciiTable from './components/AsciiTable.vue'
import SettingsModal from './components/SettingsModal.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import IncompatibleBrowser from './components/IncompatibleBrowser.vue'
import { useTheme } from './composables/useTheme'
import { provideActiveSession } from './composables/useSession'
import { createSession } from './session'
import { STORAGE_PREFIX } from './composables/useStorage'
import type { Session } from './session'
import type { AsciiEntry } from './utils/ascii-table'
import type { DataMode } from './types'

// 多会话 tab：每个 tab 一个 Session（独立驱动 + 独立 store 六件套）。
// settings 为全局共享（session/index.ts L57 注入同一 proxy）。
const sessions = ref<Session[]>([])
const activeSessionId = ref(0)
const activeSession = computed(() => sessions.value[activeSessionId.value])

// 初始建第 1 个会话（单会话默认行为，与改造前一致）
sessions.value.push(createSession())
// 传 ref/computed 本身（非 .value）：provide 只执行一次，传解包值会固定为会话 0
provideActiveSession(activeSession)

function onNewSession() {
  const s = createSession()
  sessions.value.push(s)
  activeSessionId.value = sessions.value.length - 1
  // 新会话独立驱动，端口列表为空，需主动拉取一次（初始会话在 onMounted 拉取）
  s.serial.refreshPorts()
}

function onCloseSession(id: number) {
  if (sessions.value.length <= 1) return // 末 tab 保护：至少保留 1 个会话
  const s = sessions.value[id]
  sessions.value.splice(id, 1)
  s.dispose()
  if (activeSessionId.value === id) {
    activeSessionId.value = Math.min(id, sessions.value.length - 1)
  } else if (activeSessionId.value > id) {
    activeSessionId.value--
  }
}

// —— 对话框 opener 会话绑定 ——
// 对话框由会话内组件（ConnectionBar/InputComposer）触发但渲染在根层；
// 打开那一刻记录触发会话 id，之后切 tab 不影响已打开的对话框。
const showAscii = ref(false)
const showSettings = ref(false)
const showFileTransfer = ref(false)
const fileTransferDropFile = ref<File | null>(null)
const openerSessionId = ref(0)
function bindOpener() {
  openerSessionId.value = activeSessionId.value
}
function onOpenAscii() {
  bindOpener()
  showAscii.value = true
}
function onOpenSettings() {
  bindOpener()
  showSettings.value = true
}
function onOpenFileTransfer(file?: File) {
  bindOpener()
  fileTransferDropFile.value = file ?? null
  showFileTransfer.value = true
}
const openerSession = computed(() => sessions.value[openerSessionId.value] ?? activeSession.value)

// AsciiTable 插入 / 快速命令「调到发送框」转发：落到活动会话对应的 SessionPane
const sessionPaneRefs = ref<InstanceType<typeof SessionPane>[]>([])
function onInsertAscii(entry: AsciiEntry) {
  sessionPaneRefs.value[activeSessionId.value]?.insertAscii(entry)
}
function onToComposer(p: { text: string; mode: DataMode }) {
  sessionPaneRefs.value[activeSessionId.value]?.toComposer(p)
}

const commandsCollapsed = ref(false)

// —— 快速命令侧边栏宽度拖拽 ——
// 手柄在侧边栏左边缘：向左拖增大、向右拖减小。
const COL_MIN = 200
const COL_MAX = 480
const DEFAULT_RIGHT_WIDTH = 280
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
        <MenuBar />
        <div class="session-tabs">
          <div
            v-for="(s, i) in sessions"
            :key="s.id"
            class="session-tab"
            :class="{ active: i === activeSessionId }"
            @click="activeSessionId = i"
          >
            <span class="session-tab-name" :title="s.serial.selectedPort ?? undefined">{{ s.serial.selectedPort ?? t('session.tabLabel', { n: i + 1 }) }}</span>
            <span
              class="session-tab-dot"
              :class="{ on: s.serial.connected, reconnecting: s.serial.reconnecting }"
            />
            <button
              class="session-tab-close"
              :disabled="sessions.length <= 1"
              :title="t('session.close')"
              @click.stop="onCloseSession(i)"
            >×</button>
          </div>
          <button class="session-tab-new" @click="onNewSession" :title="t('session.new')">＋</button>

          <!-- 全局功能按钮：作用于当前活动会话，不随会话 tab 重复 -->
          <div class="session-tabs-spacer" />
          <button class="global-btn" @click="onOpenAscii" :title="t('conn.asciiTable')">{{ t('conn.asciiTable') }}</button>
          <button class="global-btn" @click="onOpenSettings" :title="t('conn.settings')">{{ t('conn.settings') }}</button>
        </div>

        <div class="main">
          <div class="session-panes">
            <SessionPane
              v-for="(s, i) in sessions"
              :key="s.id"
              v-show="i === activeSessionId"
              :ref="(el) => (sessionPaneRefs[i] = el as InstanceType<typeof SessionPane>)"
              :session="s"
              @open-file-transfer="onOpenFileTransfer"
            />
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
      <SettingsModal v-model:show="showSettings" :session="openerSession" />
      <FileTransferDialog
        v-model:show="showFileTransfer"
        :drop-file="fileTransferDropFile"
        :session="openerSession"
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
.session-tabs {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px 6px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}
.session-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.session-tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
.session-tab.active {
  background: var(--bg-elevated);
  color: var(--accent);
  border-color: var(--border);
}
.session-tab-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-tab-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.5;
  flex-shrink: 0;
}
.session-tab-dot.on {
  background: #4caf50;
  opacity: 1;
}
.session-tab-dot.reconnecting {
  background: #ff9800;
  opacity: 1;
}
.session-tab-close {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.session-tab-close:hover:not(:disabled) {
  color: var(--err);
  background: rgba(255, 0, 0, 0.08);
}
.session-tab-close:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.session-tab-new {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.session-tab-new:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
.session-tabs-spacer {
  flex: 1;
}
.global-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color 0.15s, background 0.15s;
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
.session-panes {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.right {
  flex: none;
  width: 280px;
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
