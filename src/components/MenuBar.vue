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
import { useUpdater } from '@/composables/useUpdater'
import KnowledgeBaseModal from './KnowledgeBaseModal.vue'
import UpdateDialog from './UpdateDialog.vue'

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

const updater = useUpdater()

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

/** 统一文本槽位：所有菜单项在文本前留等宽 ✓ 列（选中显示 ✓、未选中留空），
 *  保证两个菜单、各项的文本左缘对齐。不走 naive-ui 的 icon 前缀槽——该槽只给
 *  带 icon 的项缩进（主题 optionIconPrefixWidth 24px），无 icon 项顶格，会错位。
 *  槽宽 20px：✓（约 8px）居中后两侧各留 ~6px，符号与文字不贴 */
function menuLabel(selected: boolean, text: string) {
  return () =>
    h('span', null, [
      h('span', { style: 'display:inline-block;width:20px;text-align:center' }, selected ? '✓' : ''),
      text,
    ])
}

/** naive-ui 给无 icon 的选项也渲染 10px 空前缀列（主题 optionPrefixWidth），
 *  会把菜单项文本整体推离面板左缘——本菜单全为文本型选项，归零；
 *  与按钮 20px 文字内边距 + menuLabel 20px 勾选槽配合：面板左缘（=按钮左缘，
 *  bottom-start）+20 即按钮文字 x，菜单项文本与「文件/帮助」文字精确重合。
 *  字号同步为菜单按钮的 tiny 12px（Dropdown 默认 13px 会比标题大一号，不协调） */
const menuDropdownOverrides = {
  fontSizeSmall: '12px',
  fontSizeMedium: '12px',
  optionPrefixWidthSmall: '0px',
  optionPrefixWidthMedium: '0px',
  optionPrefixWidthLarge: '0px',
  optionPrefixWidthHuge: '0px',
}

const fileMenu = computed<DropdownOption[]>(() => [
  { label: menuLabel(settingsStore.autoSave, t('menu.autoSave')), key: 'auto-save' },
  { type: 'divider', key: 'd1' },
  { label: menuLabel(false, t('menu.exportLog')), key: 'export-log' },
  { type: 'divider', key: 'd2' },
  {
    label: menuLabel(
      false,
      recorder.value.state.status === 'idle' ? t('record.startRecording') : t('record.stopRecording')
    ),
    key: 'toggle-recording',
    disabled: !recorder.value.supported || recorder.value.state.status === 'stopping'
  },
  { type: 'divider', key: 'd3' },
  { label: menuLabel(false, t('menu.resetDefaults')), key: 'reset-defaults' }
])

const helpMenu = computed<DropdownOption[]>(() => [
  { label: menuLabel(false, t('menu.knowBase')), key: 'know-base' },
  { type: 'divider', key: 'd1' },
  { label: menuLabel(false, t('menu.shortcuts')), key: 'shortcuts' },
  // 「检查更新」仅桌面版（Electron）存在；浏览器无 updater 桥不展示
  ...(window.electron?.updater
    ? [
        { type: 'divider' as const, key: 'd2' },
        { label: menuLabel(false, t('menu.checkUpdate')), key: 'check-update' }
      ]
    : []),
  { type: 'divider', key: 'd3' },
  { label: menuLabel(false, t('menu.about')), key: 'about' },
  { type: 'divider', key: 'd4' },
  { label: menuLabel(false, t('menu.license')), key: 'license' },
  { type: 'divider', key: 'd5' },
  { label: menuLabel(false, t('menu.devtools')), key: 'devtools' }
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
    case 'check-update':
      void updater.check()
      break
  }
}
</script>

<template>
  <div class="menubar">
    <!-- bottom-start：面板左缘对齐菜单按钮左缘；配合按钮 12px 文字内边距与菜单项
         12px 勾选槽，菜单项文本与「文件/帮助」按钮文字左缘精确重合（默认 bottom
         居中放置，面板比按钮宽时会整体左漂，与按钮错位） -->
    <NDropdown
      trigger="click"
      placement="bottom-start"
      :options="fileMenu"
      :theme-overrides="menuDropdownOverrides"
      @select="handleSelect"
    >
      <NButton size="tiny" quaternary>{{ t('menu.file') }}</NButton>
    </NDropdown>
    <NDropdown
      trigger="click"
      placement="bottom-start"
      :options="helpMenu"
      :theme-overrides="menuDropdownOverrides"
      @select="handleSelect"
    >
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
  <UpdateDialog />
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
  position: relative;
}
/* 顶部 1px inset 高光 — 让"玻璃"在同色背景上明显 */
.menubar::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent 0%,
    var(--glass-highlight) 12%,
    var(--glass-highlight) 88%,
    transparent 100%
  );
  pointer-events: none;
  opacity: 0.7;
}
.menubar-spacer {
  flex: 1;
}
/* 菜单按钮文字内边距 = 菜单项勾选槽宽度（menuLabel 20px）：
   bottom-start 下面板左缘=按钮左缘，两项相加后菜单项文本与按钮文字左缘重合 */
.menubar :deep(.n-button) {
  padding: 0 20px;
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
  font-family: var(--display-font);
  letter-spacing: var(--display-letter-spacing);
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
