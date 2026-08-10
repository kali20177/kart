<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import { NDropdown, NButton, NModal, useMessage, useDialog } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useActiveSession } from '@/composables/useSession'
import { useSettingsStore } from '@/stores/settings'
import { useCommandsStore } from '@/stores/commands'
import { storage } from '@/composables/useStorage'
import { onSnapshotExport } from '@/utils/persist'
import { useI18n } from 'vue-i18n'
import { logger } from '@/utils/logger'
import KnowledgeBaseModal from './KnowledgeBaseModal.vue'

const { t } = useI18n()
// settings/commands 为全局共享 store（会话间统一），serial/recorder 指向当前活动会话。
// useActiveSession 返回活动会话 ref，用 computed 派生 serial/recorder：切 tab 时自动跟随。
const settingsStore = useSettingsStore()
const commandsStore = useCommandsStore()
const activeSession = useActiveSession()
const serialStore = computed(() => activeSession.value.serial)
const recorder = computed(() => activeSession.value.recorder)
const message = useMessage()
const dialog = useDialog()

const showAbout = ref(false)
const showLicense = ref(false)
const showShortcuts = ref(false)
const showKnowBase = ref(false)

// 容量告警快照导出成功的提示（persist.ts 通过事件广播，UI 层在此消费）
onMounted(() => {
  offSnapshot = onSnapshotExport(() => {
    message.success(t('persist.snapshotExported'))
  })
})
onUnmounted(() => offSnapshot?.())
let offSnapshot: (() => void) | null = null

/** 检测是否为 macOS（userAgent + platform 双保险，部分浏览器 platform 已被屏蔽） */
const isMac = computed(() => {
  const p = window.electron?.platform ?? navigator.platform
  return /mac|darwin/i.test(p) || /mac/i.test(navigator.userAgent)
})

/** 平台修饰键：macOS 显示 ⌘，其他显示 Ctrl */
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')

/** 历史翻页修饰键：macOS 上 Ctrl+↑/↓ 被 Mission Control 占用，改用 Alt */
const navModKey = computed(() => isMac.value ? 'Alt' : 'Ctrl')

const shortcutList = computed(() => [
  { combo: `${modKey.value}+Enter`, desc: t('composer.send') },
  { combo: `${navModKey.value}+↑`, desc: t('composer.historyPrev') },
  { combo: `${navModKey.value}+↓`, desc: t('composer.historyNext') }
])

/** 关于对话框的版本信息行（参考 VSCode：版本 / 提交 / 构建日期 / 依赖与运行时版本） */
const aboutRows = computed<Array<[string, string]>>(() => {
  const deps = __DEP_VERSIONS__
  const rows: Array<[string, string]> = [
    [t('about.version'), __APP_VERSION__],
    [t('about.commit'), __GIT_COMMIT__],
    [t('about.buildDate'), new Date(__BUILD_DATE__).toLocaleString()],
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
  rows.push([t('about.platform'), window.electron?.platform ?? navigator.platform])
  return rows
})

function copyAbout() {
  const text = [`${t('app.name')}`, ...aboutRows.value.map(([k, v]) => `${k}: ${v}`)].join('\n')
  navigator.clipboard?.writeText(text)
  message.success(t('about.versionCopied'))
}

/** 勾选标记：选中项左侧显示 ✓，未选中留出等宽占位以对齐 */
function check(selected: boolean) {
  return () => h('span', { style: 'display:inline-block;width:12px;text-align:center' }, selected ? '✓' : '')
}

const fileMenu = computed<DropdownOption[]>(() => [
  { label: t('menu.autoSave'), key: 'auto-save', icon: check(settingsStore.autoSave) },
  { type: 'divider', key: 'd1' },
  { label: t('menu.exportLog'), key: 'export-log' },
  { type: 'divider', key: 'd2' },
  {
    label: recorder.value.state.status === 'idle' ? t('record.startRecording') : t('record.stopRecording'),
    key: 'toggle-recording',
    disabled: !recorder.value.supported || recorder.value.state.status === 'stopping'
  },
  { type: 'divider', key: 'd3' },
  { label: t('menu.resetDefaults'), key: 'reset-defaults' }
])

const helpMenu = computed<DropdownOption[]>(() => [
  { label: t('menu.knowBase'), key: 'know-base' },
  { type: 'divider', key: 'd1' },
  { label: t('menu.shortcuts'), key: 'shortcuts' },
  { type: 'divider', key: 'd2' },
  { label: t('menu.about'), key: 'about' },
  { type: 'divider', key: 'd3' },
  { label: t('menu.license'), key: 'license' },
  { type: 'divider', key: 'd4' },
  { label: t('menu.devtools'), key: 'devtools' }
])

function handleSelect(key: string) {
  switch (key) {
    case 'auto-save':
      settingsStore.autoSave = !settingsStore.autoSave
      break
    case 'export-log':
      logger.downloadExport()
        .then(count => {
          if (count > 0) message.success(t('log.exported'))
          else message.info(t('log.empty'))
        })
        .catch(e => {
          logger.error('app', 'log export failed', e)
          message.error(t('log.exportFailed'))
        })
      break
    case 'toggle-recording':
      if (recorder.value.state.status === 'idle') {
        recorder.value.start().catch((e) => {
          message.error(e instanceof Error ? e.message : String(e))
        })
      } else {
        recorder.value.stop()
      }
      break
    case 'reset-defaults':
      dialog.warning({
        title: t('menu.resetDefaults'),
        content: t('menu.resetDefaultsConfirm'),
        positiveText: t('menu.resetDefaults'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => {
          logger.info('app', 'settings reset to defaults')
          // 1. 设置 -> 默认（reset 改内存；autoSave=true 时 deep watch 自动落盘）
          settingsStore.reset()
          // 2. autoSave 开关本身也恢复默认 true（若原为 false，其 watch 会补落盘 settings）
          settingsStore.autoSave = true
          // 3. 串口参数 + 自定义波特率 -> 默认
          serialStore.value.reset()
          // 4. 快捷命令 -> 内置预设（watch 自动落盘）
          commandsStore.resetToPresets()
          // 5. 导出偏好 -> 清除（下次打开对话框用 DEFAULT_PREFS fallback）
          storage.remove('export-preferences')
          // 6. 面板布局 -> 清除持久值，并通知组件就地改回默认
          storage.remove('app:rightWidth')
          storage.remove('composer:inputHeight')
          window.dispatchEvent(new CustomEvent('app:reset-layout'))
          message.success(t('menu.resetDefaultsDone'))
        }
      })
      break
    case 'know-base':
      showKnowBase.value = true
      break
    case 'about':
      showAbout.value = true
      break
    case 'license':
      showLicense.value = true
      break
    case 'shortcuts':
      showShortcuts.value = true
      break
    case 'devtools':
      if (window.electron?.toggleDevTools) {
        window.electron.toggleDevTools()
      } else {
        message.info(t('about.browserDevtools'))
      }
      break
  }
}
</script>

<template>
  <div class="menubar">
    <NDropdown trigger="click" :options="fileMenu" @select="handleSelect">
      <NButton size="tiny" quaternary>{{ t('menu.file') }}</NButton>
    </NDropdown>
    <NDropdown trigger="click" :options="helpMenu" @select="handleSelect">
      <NButton size="tiny" quaternary>{{ t('menu.help') }}</NButton>
    </NDropdown>
    <!-- 右侧插槽：全局功能按钮（ASCII/设置）复用本行，不额外占行高 -->
    <div class="menubar-spacer" />
    <slot />
  </div>

  <NModal v-model:show="showAbout" preset="card" :title="t('menu.about')" style="width: 420px">
    <div class="about">
      <div class="app-name">{{ t('app.name') }}</div>
      <p class="desc">{{ t('app.desc') }}</p>
      <div class="versions">
        <template v-for="[k, v] in aboutRows" :key="k">
          <span class="ver-key">{{ k }}</span>
          <span class="ver-val">{{ v }}</span>
        </template>
      </div>
    </div>
    <template #footer>
      <div style="display: flex; justify-content: flex-end">
        <NButton size="small" @click="copyAbout">{{ t('menu.copy') }}</NButton>
      </div>
    </template>
  </NModal>

  <NModal v-model:show="showLicense" preset="card" :title="t('menu.license')" style="width: 420px">
    <div class="license">
      <p>{{ t('about.licenseText') }}</p>
      <p>{{ t('about.ossNotice') }}</p>
      <ul>
        <li>Vue 3 — MIT</li>
        <li>Pinia — MIT</li>
        <li>Naive UI — MIT</li>
        <li>Vite — MIT</li>
        <li>Tauri — MIT/Apache-2.0</li>
      </ul>
    </div>
  </NModal>

  <NModal v-model:show="showShortcuts" preset="card" :title="t('menu.shortcuts')" style="width: 420px">
    <div class="shortcuts">
      <div class="shortcut-row" v-for="{ combo, desc } in shortcutList" :key="combo">
        <span class="shortcut-keys"><kbd v-for="k in combo.split('+')" :key="k">{{ k }}</kbd></span>
        <span class="shortcut-desc">{{ desc }}</span>
      </div>
    </div>
  </NModal>

  <KnowledgeBaseModal v-model:show="showKnowBase" />
</template>

<style scoped>
.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}
.menubar-spacer {
  flex: 1;
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
.shortcuts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shortcut-row {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
}
.shortcut-keys {
  display: flex;
  gap: 4px;
  min-width: 100px;
}
.shortcut-keys kbd {
  display: inline-block;
  padding: 2px 7px;
  font-family: var(--mono-font);
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  line-height: 1.4;
  white-space: nowrap;
}
.shortcut-desc {
  color: var(--text);
}
</style>
