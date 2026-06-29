<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import MenuBar from './components/MenuBar.vue'
import ConnectionBar from './components/ConnectionBar.vue'
import MessageList from './components/MessageList.vue'
import InputComposer from './components/InputComposer.vue'
import QuickCommandsPanel from './components/QuickCommandsPanel.vue'
import AsciiTable from './components/AsciiTable.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import StatusBar from './components/StatusBar.vue'
import { useSerialStore } from './stores/serial'
import { useSettingsStore } from './stores/settings'
import type { DataMode } from './types'
import type { AsciiEntry } from './utils/ascii-table'

const serial = useSerialStore()
const settingsStore = useSettingsStore()

const viewMode = ref<DataMode>(settingsStore.settings.defaultView)
const composerText = ref('')
const showAscii = ref(false)
const showSettings = ref(false)
const commandsCollapsed = ref(false)

// —— 快速命令侧边栏宽度拖拽 ——
// 手柄在侧边栏左边缘：向左拖增大、向右拖减小。
const COL_MIN = 200
const COL_MAX = 480
const rightWidth = ref(280)
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
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onColGripMove)
})

// 主题：system → 跟随媒体查询
const prefersDark =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
const isDark = computed(() => {
  const t = settingsStore.settings.theme
  if (t === 'system') return prefersDark?.matches ?? true
  return t === 'dark'
})
const naiveTheme = computed(() => (isDark.value ? darkTheme : null))

watch(
  isDark,
  (dark) => document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light'),
  { immediate: true }
)
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

function onInsertAscii(e: AsciiEntry) {
  if (viewMode.value === 'hex') {
    composerText.value += (composerText.value && !composerText.value.endsWith(' ') ? ' ' : '') + e.hex + ' '
  } else if (e.char != null) {
    composerText.value += e.char
  }
}

onMounted(() => {
  serial.refreshPorts()
})
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <div class="app">
        <MenuBar />
        <ConnectionBar @open-ascii="showAscii = true" @open-settings="showSettings = true" />

        <div class="main">
          <div class="left">
            <MessageList :view-mode="viewMode" @resend="onResend" />
            <InputComposer v-model:text="composerText" v-model:mode="viewMode" />
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
      <SettingsDrawer v-model:show="showSettings" />
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
  border-radius: 0 4px 4px 0;
}
</style>
