<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN, enUS, dateEnUS } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import MenuBar from './components/MenuBar.vue'
import ConnectionBar from './components/ConnectionBar.vue'
import MessageList from './components/MessageList.vue'
import WaveformChart from './components/WaveformChart.vue'
import InputComposer from './components/InputComposer.vue'
import QuickCommandsPanel from './components/QuickCommandsPanel.vue'
import AsciiTable from './components/AsciiTable.vue'
import SettingsModal from './components/SettingsModal.vue'
import StatusBar from './components/StatusBar.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import { useSerialStore } from './stores/serial'
import { useSettingsStore } from './stores/settings'
import { useTheme } from './composables/useTheme'
import { storage } from './composables/useStorage'
import type { DataMode } from './types'
import type { AsciiEntry } from './utils/ascii-table'

const serial = useSerialStore()
const settingsStore = useSettingsStore()
const { t, locale } = useI18n()

// 主题（替代 useIsDark + 手动 themeOverrides）
const { naiveTheme, naiveOverrides } = useTheme()

// 语言切换：同步 settings → vue-i18n + html lang
watch(
  () => settingsStore.settings.locale,
  (l) => {
    locale.value = l
    document.documentElement.setAttribute('lang', l === 'zh-CN' ? 'zh-CN' : 'en')
    document.title = t('app.name')
  },
  { immediate: true }
)

// Naive UI 语言包
const naiveLocale = computed(() => (settingsStore.settings.locale === 'zh-CN' ? zhCN : enUS))
const naiveDateLocale = computed(() => (settingsStore.settings.locale === 'zh-CN' ? dateZhCN : dateEnUS))

// 主区域视图：[消息] / [波形]。v-show 切换（不卸载），波形隐藏时仍缓冲数据
const mainView = ref<'messages' | 'waveform'>('messages')

const viewMode = ref<DataMode>(settingsStore.settings.defaultView)
const composerText = ref('')
const showAscii = ref(false)
const showSettings = ref(false)
const showFileTransfer = ref(false)
const fileTransferDropFile = ref<File | null>(null)
const commandsCollapsed = ref(false)

// —— 快速命令侧边栏宽度拖拽 ——
// 手柄在侧边栏左边缘：向左拖增大、向右拖减小。
const COL_MIN = 200
const COL_MAX = 480
const DEFAULT_RIGHT_WIDTH = 280
const rightWidth = ref(storage.get('app:rightWidth', DEFAULT_RIGHT_WIDTH))
const dragging = ref(false)
const rightStyle = computed(() =>
  commandsCollapsed.value ? {} : { width: rightWidth.value + 'px' }
)
let colDragStartX = 0
let colDragStartW = 0

function onColGripDown(e: PointerEvent) {
  if (commandsCollapsed.value) return
  e.preventDefault()
  dragging.value = true
  colDragStartX = e.clientX
  colDragStartW = rightWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onColGripMove)
  window.addEventListener('pointerup', onColGripUp, { once: true })
}

function onColGripMove(e: PointerEvent) {
  // grip 在左边缘：向左拖（delta 为负）增大宽度
  let w = colDragStartW - (e.clientX - colDragStartX)
  w = Math.max(COL_MIN, Math.min(COL_MAX, w))
  rightWidth.value = w
}

function onColGripUp() {
  dragging.value = false
  window.removeEventListener('pointermove', onColGripMove)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  storage.set('app:rightWidth', rightWidth.value)
}

/** 「恢复默认设置」时就地重置侧边栏宽度 */
function onResetLayout() {
  rightWidth.value = DEFAULT_RIGHT_WIDTH
  storage.set('app:rightWidth', DEFAULT_RIGHT_WIDTH)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onColGripMove)
  window.removeEventListener('app:reset-layout', onResetLayout)
})

watch(
  () => settingsStore.settings.fontSize,
  (px) => document.documentElement.style.setProperty('--bubble-font-size', px + 'px'),
  { immediate: true }
)

function onResend(bytes: Uint8Array) {
  serial.resend(bytes)
}

function onToComposer(p: { text: string; mode: DataMode }) {
  composerText.value = p.text
  viewMode.value = p.mode
}

/** 编码器支持的命名转义（与 encodeWithEscapes 的 switch 保持一致） */
const NAMED_ESCAPES = new Set([0, 9, 10, 13])

function onOpenFileTransfer(file?: File) {
  fileTransferDropFile.value = file ?? null
  showFileTransfer.value = true
}

function onInsertAscii(e: AsciiEntry) {
  if (viewMode.value === 'hex') {
    composerText.value += (composerText.value && !composerText.value.endsWith(' ') ? ' ' : '') + e.hex + ' '
  } else if (e.char != null) {
    composerText.value += e.char
  } else if (e.escape && NAMED_ESCAPES.has(e.dec)) {
    composerText.value += e.escape
  }
}

onMounted(() => {
  serial.refreshPorts()
  window.addEventListener('app:reset-layout', onResetLayout)
})
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="naiveOverrides" :locale="naiveLocale" :date-locale="naiveDateLocale">
    <NMessageProvider>
      <NDialogProvider>
      <div class="app">
        <MenuBar />
        <ConnectionBar @open-ascii="showAscii = true" @open-settings="showSettings = true" />

        <div class="main">
          <div class="left">
            <div class="view-tabs">
              <button
                class="tab"
                :class="{ active: mainView === 'messages' }"
                @click="mainView = 'messages'"
              >
                {{ t('app.msg') }}
              </button>
              <button
                class="tab"
                :class="{ active: mainView === 'waveform' }"
                @click="mainView = 'waveform'"
              >
                {{ t('app.waveform') }}
              </button>
            </div>

            <MessageList v-show="mainView === 'messages'" :view-mode="viewMode" @resend="onResend" />
            <WaveformChart v-show="mainView === 'waveform'" />
            <InputComposer v-model:text="composerText" v-model:mode="viewMode" @open-file-transfer="onOpenFileTransfer" />
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

        <StatusBar />
      </div>

      <AsciiTable v-model:show="showAscii" @insert="onInsertAscii" />
      <SettingsModal v-model:show="showSettings" />
      <FileTransferDialog v-model:show="showFileTransfer" :drop-file="fileTransferDropFile" @started="showFileTransfer = false" />
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
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.view-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
}
.tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  padding: 7px 16px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
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
