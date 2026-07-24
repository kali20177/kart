<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NInputNumber,
  NSwitch,
  NButton,
  NButtonGroup,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useSerialStore } from '@/stores/serial'
import { useRecordDirectory } from '@/composables/useRecordDirectory'
import { listThemes } from '@/themes'

const show = defineModel<boolean>('show', { default: false })
const settingsStore = useSettingsStore()
const serial = useSerialStore()
const recordDir = useRecordDirectory()
const { t } = useI18n()
const message = useMessage()
const s = settingsStore.settings

const activeTab = ref('receive')

const encodingOptions = computed(() => [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'ASCII', value: 'ascii' },
  { label: 'GBK', value: 'gbk' }
])
const strategyOptions = computed(() => [
  { label: t('settings.gapTimeout'), value: 'gap-timeout' },
  { label: t('settings.delimiter'), value: 'delimiter' },
  { label: t('settings.fixedLength'), value: 'fixed-length' }
])
const viewOptions = computed(() => [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
])
const checksumAlgoOptions = computed(() => [
  { label: t('checksum.algo.none'), value: 'none' },
  { label: t('checksum.algo.sum8'), value: 'sum8' },
  { label: t('checksum.algo.xor8'), value: 'xor8' },
  { label: t('checksum.algo.crc16-modbus'), value: 'crc16-modbus' },
  { label: t('checksum.algo.crc32'), value: 'crc32' }
])
const themeOptions = computed(() =>
  listThemes().map(t => ({ label: t.name, value: t.id }))
)
const numericTypeOptions = computed(() => [
  { label: 'uint8 (1B)', value: 'uint8' },
  { label: 'int8 (1B)', value: 'int8' },
  { label: 'uint16 (2B)', value: 'uint16' },
  { label: 'int16 (2B)', value: 'int16' },
  { label: 'uint32 (4B)', value: 'uint32' },
  { label: 'int32 (4B)', value: 'int32' },
  { label: 'float32 (4B)', value: 'float32' },
  { label: 'float64 (8B)', value: 'float64' }
])

// 浏览器原生目录选择(File System Access API)仅 Chromium 在安全上下文下可用;
// Electron 走专用 IPC 路径,恒可点。
const canPickDir = computed(() => Boolean(window.electron?.recorder?.showDirectoryPicker) || ('showDirectoryPicker' in window))

async function pickDir() {
  try {
    await recordDir.pick()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // useRecordDirectory.pick() 在环境不支持的分支抛出"当前环境不支持选择目录"
    if (msg.includes('不支持选择目录')) {
      message.error(t('record.pickerUnsupported'), { duration: 6000 })
    } else {
      message.error(`${t('record.pickFailed')}: ${msg}`, { duration: 6000 })
    }
  }
}

// 侧边栏导航项
interface NavItem {
  key: string
  label: string
  icon: string // SVG path data (simple, 16x16 viewBox)
}

const navItems = computed<NavItem[]>(() => [
  {
    key: 'receive',
    label: t('settings.receive'),
    icon: 'M8 2v10M4 8l4 4 4-4M2 14h12'
  },
  {
    key: 'display',
    label: t('settings.display'),
    icon: 'M2 4h12v9H2zM5 13v1h6v-1'
  },
  {
    key: 'waveform',
    label: t('settings.waveform'),
    icon: 'M1 8l3-5 3 7 3-9 3 11 2-4'
  },
  {
    key: 'connection',
    label: t('settings.connection'),
    icon: 'M8 3v10M3 8h10M5 5l6 6M11 5l-6 6'
  },
  {
    key: 'baud',
    label: t('settings.baudRate'),
    icon: 'M8 5a3 3 0 100 6 3 3 0 000-6zM5.5 8h5M8 5.5v5'
  },
  {
    key: 'record',
    label: t('settings.record'),
    icon: 'M8 2v10M4 8l4 4 4-4M2 14h12'
  },
  {
    key: 'checksum',
    label: t('settings.checksum'),
    icon: 'M3 7l3-4 3 4v7H3zM6 10h6M11.8 10l1.8 4.2-1.8-4.2z'
  }
])
</script>

<template>
  <NModal
    v-model:show="show"
    :style="{ maxWidth: '800px', width: '92vw' }"
    preset="card"
    :title="t('settings.title')"
    closable
    :bordered="false"
    :mask-closable="false"
    class="settings-modal"
  >
    <div class="settings-body">
      <nav class="settings-nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeTab === item.key }"
          @click="activeTab = item.key"
        >
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path :d="item.icon" />
          </svg>
          <span>{{ item.label }}</span>
        </button>

        <div class="nav-spacer" />

        <button class="nav-item nav-reset" @click="settingsStore.reset()">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8a6 6 0 0111.3-3M14 8a6 6 0 01-11.3 3" />
            <path d="M13 2v3h-3M3 14v-3h3" />
          </svg>
          <span>{{ t('settings.reset') }}</span>
        </button>
      </nav>

      <div class="settings-content">
        <div class="content-pane">
        <!-- ========== 接收 ========== -->
        <NForm v-if="activeTab === 'receive'" label-placement="top" size="small">
          <div class="section-title">{{ t('settings.receive') }}</div>
          <NFormItem :label="t('settings.encoding')">
            <NSelect v-model:value="s.encoding" :options="encodingOptions" />
          </NFormItem>
          <NFormItem :label="t('settings.frameStrategy')">
            <NSelect v-model:value="s.frame.strategy" :options="strategyOptions" />
          </NFormItem>
          <NFormItem v-if="s.frame.strategy === 'gap-timeout'" :label="t('settings.gapMs')">
            <NInputNumber v-model:value="s.frame.gapMs" :min="1" :max="1000" style="width: 100%" />
          </NFormItem>
          <NFormItem v-if="s.frame.strategy === 'delimiter'" :label="t('settings.delimiterHex')">
            <NSelect
              v-model:value="s.frame.delimiterHex"
              :options="[
                { label: '\\n (0A)', value: '0A' },
                { label: '\\r\\n (0D0A)', value: '0D0A' },
                { label: '\\r (0D)', value: '0D' }
              ]"
              tag
              filterable
            />
          </NFormItem>
          <NFormItem v-if="s.frame.strategy === 'fixed-length'" :label="t('settings.fixedLengthBytes')">
            <NInputNumber v-model:value="s.frame.fixedLength" :min="1" :max="4096" style="width: 100%" />
          </NFormItem>
          <NFormItem :label="t('settings.bufferLimit')">
            <NInputNumber v-model:value="s.bufferLimit" :min="100" :max="100000" :step="500" style="width: 100%" />
          </NFormItem>
        </NForm>

        <!-- ========== 显示 ========== -->
        <NForm v-if="activeTab === 'display'" label-placement="top" size="small">
          <div class="section-title">{{ t('settings.display') }}</div>
          <NFormItem :label="t('settings.defaultView')">
            <NSelect v-model:value="s.defaultView" :options="viewOptions" />
          </NFormItem>
          <NFormItem :label="t('settings.theme')">
            <NSelect v-model:value="s.themeId" :options="themeOptions" />
          </NFormItem>
          <NFormItem :label="t('settings.fontSize')">
            <NInputNumber v-model:value="s.fontSize" :min="10" :max="20" style="width: 100%" />
          </NFormItem>
          <NFormItem :label="t('settings.lang')">
            <NButtonGroup>
              <NButton
                :type="s.locale === 'zh-CN' ? 'primary' : 'default'"
                @click="s.locale = 'zh-CN'"
                size="small"
              >中文</NButton>
              <NButton
                :type="s.locale === 'en-US' ? 'primary' : 'default'"
                @click="s.locale = 'en-US'"
                size="small"
              >English</NButton>
            </NButtonGroup>
          </NFormItem>
          <NFormItem :label="t('settings.pauseNotify')">
            <NSwitch v-model:value="s.showPauseNotification">
              <template #checked>{{ t('settings.pauseNotifyOn') }}</template>
              <template #unchecked>{{ t('settings.pauseNotifyOff') }}</template>
            </NSwitch>
          </NFormItem>
        </NForm>

        <!-- ========== 波形解析 ========== -->
        <NForm v-if="activeTab === 'waveform'" label-placement="top" size="small">
          <div class="section-title">{{ t('settings.waveform') }}</div>
          <NFormItem :label="t('settings.numericType')">
            <NSelect v-model:value="s.waveform.parse.type" :options="numericTypeOptions" />
          </NFormItem>
          <NFormItem :label="t('settings.byteOrder')">
            <NSwitch v-model:value="s.waveform.parse.littleEndian">
              <template #checked>{{ t('settings.littleEndian') }}</template>
              <template #unchecked>{{ t('settings.bigEndian') }}</template>
            </NSwitch>
          </NFormItem>
          <NFormItem :label="t('settings.channels')">
            <NInputNumber
              v-model:value="s.waveform.parse.channels"
              :min="1"
              :max="16"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem :label="t('settings.byteOffset')">
            <NInputNumber
              v-model:value="s.waveform.parse.byteOffset"
              :min="0"
              :max="64"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem :label="t('settings.sampleRate')">
            <NInputNumber
              v-model:value="s.waveform.sampleRate"
              :min="1"
              :max="100000"
              :step="10"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem :label="t('settings.maxPoints')">
            <NInputNumber
              v-model:value="s.waveform.maxPoints"
              :min="100"
              :max="100000"
              :step="500"
              style="width: 100%"
            />
          </NFormItem>
        </NForm>

        <!-- ========== 连接 ========== -->
        <NForm v-if="activeTab === 'connection'" label-placement="top" size="small">
          <div class="section-title">{{ t('settings.connection') }}</div>
          <NFormItem :label="t('settings.autoReconnect')">
            <NSwitch v-model:value="s.autoReconnect" />
          </NFormItem>
        </NForm>

        <!-- ========== 自定义波特率 ========== -->
        <div v-if="activeTab === 'baud'" class="baud-section">
          <div class="section-title">{{ t('settings.customBaud') }}</div>
          <div v-if="serial.customBaudRates.length === 0" class="empty-hint">
            {{ t('settings.baudEmpty') }}
          </div>
          <div
            v-for="item in serial.customBaudRates"
            :key="item.baud"
            class="custom-baud-row"
          >
            <span class="custom-baud-num">{{ item.baud }}</span>
            <NInput
              size="small"
              :value="item.note ?? ''"
              :placeholder="t('settings.baudNote')"
              @update:value="(v: string) => serial.updateCustomBaudNote(item.baud, v)"
            />
            <NButton
              size="small"
              quaternary
              type="error"
              @click="serial.removeCustomBaudRate(item.baud)"
            >
              {{ t('settings.delete') }}
            </NButton>
          </div>
        </div>

        <!-- ========== 录制 ========== -->
        <div v-if="activeTab === 'record'" class="record-section">
          <div class="section-title">{{ t('settings.record') }}</div>
          <NForm label-placement="top" size="small">
            <NFormItem :label="t('record.format')">
              <NSelect
                v-model:value="s.recordFormat"
                :options="[
                  { label: 'txt (.txt)', value: 'text' },
                  { label: 'CSV (.csv)', value: 'csv' }
                ]"
              />
            </NFormItem>
            <NFormItem :label="t('record.saveDir')">
              <div class="record-dir-row">
                <span class="record-dir-name">{{ recordDir.dirName.value ?? ('(' + t('record.notSet') + ')') }}</span>
                <NButton size="small" :disabled="!canPickDir" @click="pickDir">{{ t('record.selectDir') }}</NButton>
              </div>
              <div v-if="!canPickDir" class="record-dir-hint">{{ t('record.pickerUnsupported') }}</div>
            </NFormItem>
          </NForm>
        </div>

        <!-- ========== 校验和 ========== -->
        <div v-if="activeTab === 'checksum'" class="checksum-section">
          <div class="section-title">{{ t('checksum.title') }}</div>
          <NForm label-placement="top" size="small">
            <NFormItem :label="t('checksum.txDefault')">
              <NSelect
                v-model:value="s.sendChecksum"
                :options="checksumAlgoOptions"
              />
            </NFormItem>
            <NFormItem :label="t('checksum.rxAlgorithm')">
              <NSelect
                v-model:value="s.rxChecksumAlgorithm"
                :options="checksumAlgoOptions"
              />
            </NFormItem>
          </NForm>
        </div>
        </div>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.settings-body {
  display: flex;
  gap: 0;
  height: 430px;
}

/* ===== 左侧导航 ===== */
.settings-nav {
  width: 164px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px 4px 4px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font-family: var(--ui-font);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.nav-item:hover {
  background: var(--bg-elevated);
  color: var(--text);
}

.nav-item.active {
  background: var(--accent);
  color: #fff;
}

.nav-icon {
  flex: none;
  width: 16px;
  height: 16px;
}

.nav-spacer {
  flex: 1;
  min-height: 8px;
}

.nav-reset {
  font-size: 12px;
  color: var(--text-dim);
}

.nav-reset:hover {
  color: var(--err);
}

/* ===== 右侧内容 ===== */
.settings-content {
  flex: 1;
  min-width: 0;
  padding: 4px 0 4px 16px;
  overflow-y: auto;
}

.content-pane {
  min-height: 100%;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

/* ===== 波特率列表 ===== */
.baud-section,
.record-section {
  padding: 4px 0;
}

.empty-hint {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
}

.custom-baud-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.custom-baud-num {
  flex: none;
  width: 72px;
  font-family: var(--mono-font);
  font-size: 13px;
  color: var(--text);
}

.record-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.record-dir-name {
  flex: 1;
  font-family: var(--mono-font);
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-dir-hint {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  opacity: 0.85;
}

/* ===== NForm 内间距微调 ===== */
/* NModal preset="card" + teleport 打断 data-v 作用域链，scoped :deep() 穿不透，此处用 :global() */
:global(.n-form-item) {
  margin-bottom: 12px;
}
</style>
