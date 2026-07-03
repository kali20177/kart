<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { NDropdown, NButton, NModal, useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import { formatMessageLine } from '@/utils/message-format'
import { downloadTextFile } from '@/utils/download'

const messages = useMessagesStore()
const settingsStore = useSettingsStore()
const message = useMessage()

const APP_NAME = '串口调试助手'

const showAbout = ref(false)
const showLicense = ref(false)

/** 关于对话框的版本信息行（参考 VSCode：版本 / 提交 / 构建日期 / 依赖与运行时版本） */
const aboutRows = computed<Array<[string, string]>>(() => {
  const deps = __DEP_VERSIONS__
  const rows: Array<[string, string]> = [
    ['版本', __APP_VERSION__],
    ['提交', __GIT_COMMIT__],
    ['构建日期', new Date(__BUILD_DATE__).toLocaleString()],
    ['Vue', deps.vue],
    ['Pinia', deps.pinia],
    ['Naive UI', deps['naive-ui']],
    ['Vite', deps.vite],
    ['Electron', deps.electron]
  ]
  // Electron 运行时下追加 Chromium / Node / V8（浏览器中无此项）
  const rt = window.electron?.versions
  if (rt?.chrome) rows.push(['Chromium', rt.chrome])
  if (rt?.node) rows.push(['Node.js', rt.node])
  if (rt?.v8) rows.push(['V8', rt.v8])
  rows.push(['平台', window.electron?.platform ?? navigator.platform])
  return rows
})

function copyAbout() {
  const text = [`${APP_NAME}`, ...aboutRows.value.map(([k, v]) => `${k}: ${v}`)].join('\n')
  navigator.clipboard?.writeText(text)
  message.success('已复制版本信息')
}

/** 勾选标记：选中项左侧显示 ✓，未选中留出等宽占位以对齐 */
function check(selected: boolean) {
  return () => h('span', { style: 'display:inline-block;width:12px;text-align:center' }, selected ? '✓' : '')
}

const fileMenu = computed<DropdownOption[]>(() => [
  { label: '自动保存配置', key: 'auto-save', icon: check(settingsStore.autoSave) },
  { type: 'divider', key: 'd1' },
  { label: '导出日志', key: 'export-log' }
])

const helpMenu: DropdownOption[] = [
  { label: '关于', key: 'about' },
  { label: '许可证', key: 'license' }
]

/** 导出接收/发送记录为纯文本日志：每行 [时间戳] RX/TX: 解码文本 */
function exportLog() {
  const list = messages.messages
  if (list.length === 0) {
    message.warning('暂无日志可导出')
    return
  }
  const enc = settingsStore.settings.encoding
  const lines =
    list
      .map((m) => formatMessageLine(m, { viewMode: 'ascii', encoding: enc, timeStyle: 'full' }))
      .join('\n') + '\n'
  downloadTextFile('serial-log.txt', lines)
}

function handleSelect(key: string) {
  switch (key) {
    case 'auto-save':
      settingsStore.autoSave = !settingsStore.autoSave
      break
    case 'export-log':
      exportLog()
      break
    case 'about':
      showAbout.value = true
      break
    case 'license':
      showLicense.value = true
      break
  }
}
</script>

<template>
  <div class="menubar">
    <NDropdown trigger="click" :options="fileMenu" @select="handleSelect">
      <NButton size="tiny" quaternary>文件</NButton>
    </NDropdown>
    <NDropdown trigger="click" :options="helpMenu" @select="handleSelect">
      <NButton size="tiny" quaternary>帮助</NButton>
    </NDropdown>
  </div>

  <NModal v-model:show="showAbout" preset="card" title="关于" style="width: 420px">
    <div class="about">
      <div class="app-name">{{ APP_NAME }}</div>
      <p class="desc">嵌入式串口调试助手 —— 阶段 1：前端 UI（模拟数据驱动）</p>
      <div class="versions">
        <template v-for="[k, v] in aboutRows" :key="k">
          <span class="ver-key">{{ k }}</span>
          <span class="ver-val">{{ v }}</span>
        </template>
      </div>
    </div>
    <template #footer>
      <div style="display: flex; justify-content: flex-end">
        <NButton size="small" @click="copyAbout">复制</NButton>
      </div>
    </template>
  </NModal>

  <NModal v-model:show="showLicense" preset="card" title="许可证" style="width: 420px">
    <div class="license">
      <p>本项目为演示用途（private），未对外发布。</p>
      <p>使用的开源组件（均为 MIT 许可）：</p>
      <ul>
        <li>Vue 3 — MIT</li>
        <li>Pinia — MIT</li>
        <li>Naive UI — MIT</li>
        <li>Vite — MIT</li>
        <li>Electron — MIT</li>
      </ul>
    </div>
  </NModal>
</template>

<style scoped>
.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.about,
.license {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}
.app-name {
  font-size: 16px;
  font-weight: 600;
}
.desc {
  margin: 4px 0 12px;
  color: var(--text-dim);
}
.versions {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  font-family: var(--mono-font);
  font-size: 12px;
}
.ver-key {
  color: var(--text-dim);
}
.ver-val {
  word-break: break-all;
  user-select: text;
}
.license ul {
  margin: 6px 0 0;
  padding-left: 20px;
}
</style>
