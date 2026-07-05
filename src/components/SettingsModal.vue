<script setup lang="ts">
import { ref } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NInputNumber,
  NSwitch,
  NButton,
  useMessage
} from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import { useSerialStore } from '@/stores/serial'
import { parseHexInput } from '@/utils/hex'

const show = defineModel<boolean>('show', { default: false })
const settingsStore = useSettingsStore()
const serial = useSerialStore()
const message = useMessage()
const s = settingsStore.settings

const activeTab = ref('receive')

const encodingOptions = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'ASCII', value: 'ascii' },
  { label: 'GBK', value: 'gbk' }
]
const strategyOptions = [
  { label: '空闲超时（gap-timeout）', value: 'gap-timeout' },
  { label: '分隔符（delimiter）', value: 'delimiter' },
  { label: '定长（fixed-length）', value: 'fixed-length' }
]
const viewOptions = [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
]
const themeOptions = [
  { label: '暗色', value: 'dark' },
  { label: '亮色', value: 'light' },
  { label: '跟随系统', value: 'system' }
]
const numericTypeOptions = [
  { label: 'uint8 (1B)', value: 'uint8' },
  { label: 'int8 (1B)', value: 'int8' },
  { label: 'uint16 (2B)', value: 'uint16' },
  { label: 'int16 (2B)', value: 'int16' },
  { label: 'uint32 (4B)', value: 'uint32' },
  { label: 'int32 (4B)', value: 'int32' },
  { label: 'float32 (4B)', value: 'float32' },
  { label: 'float64 (8B)', value: 'float64' }
]

// 模拟注入
const injectText = ref('Hello from MCU\r\n')
const injectMode = ref<'ascii' | 'hex'>('ascii')
const injectModeOptions = [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
]
function doInject() {
  if (!serial.connected) {
    message.warning('请先连接端口')
    return
  }
  let bytes: Uint8Array
  if (injectMode.value === 'hex') {
    const r = parseHexInput(injectText.value)
    if (!r.ok) {
      message.error(r.error ?? 'HEX 解析失败')
      return
    }
    bytes = r.bytes
  } else {
    bytes = new TextEncoder().encode(injectText.value)
  }
  serial.inject(bytes)
}

// 侧边栏导航项
interface NavItem {
  key: string
  label: string
  icon: string // SVG path data (simple, 16x16 viewBox)
}

const navItems: NavItem[] = [
  {
    key: 'receive',
    label: '接收',
    icon: 'M8 2v10M4 8l4 4 4-4M2 14h12'
  },
  {
    key: 'display',
    label: '显示',
    icon: 'M2 4h12v9H2zM5 13v1h6v-1'
  },
  {
    key: 'waveform',
    label: '波形解析',
    icon: 'M1 8l3-5 3 7 3-9 3 11 2-4'
  },
  {
    key: 'connection',
    label: '连接',
    icon: 'M8 3v10M3 8h10M5 5l6 6M11 5l-6 6'
  },
  {
    key: 'baud',
    label: '波特率',
    icon: 'M8 5a3 3 0 100 6 3 3 0 000-6zM5.5 8h5M8 5.5v5'
  },
  {
    key: 'mock',
    label: '模拟',
    icon: 'M4 12l2-7h4l2 7M3 12h10v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1zM8 6v3'
  }
]
</script>

<template>
  <NModal
    v-model:show="show"
    :style="{ maxWidth: '800px', width: '92vw' }"
    preset="card"
    title="设置"
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
          <span>恢复默认</span>
        </button>
      </nav>

      <div class="settings-content">
        <div class="content-pane">
        <!-- ========== 接收 ========== -->
        <NForm v-if="activeTab === 'receive'" label-placement="top" size="small">
          <div class="section-title">接收</div>
          <NFormItem label="字符编码">
            <NSelect v-model:value="s.encoding" :options="encodingOptions" />
          </NFormItem>
          <NFormItem label="帧切分策略">
            <NSelect v-model:value="s.frame.strategy" :options="strategyOptions" />
          </NFormItem>
          <NFormItem v-if="s.frame.strategy === 'gap-timeout'" label="空闲超时 (ms)">
            <NInputNumber v-model:value="s.frame.gapMs" :min="1" :max="1000" style="width: 100%" />
          </NFormItem>
          <NFormItem v-if="s.frame.strategy === 'delimiter'" label="分隔符 (HEX)">
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
          <NFormItem v-if="s.frame.strategy === 'fixed-length'" label="每帧字节数">
            <NInputNumber v-model:value="s.frame.fixedLength" :min="1" :max="4096" style="width: 100%" />
          </NFormItem>
          <NFormItem label="缓冲上限（帧）">
            <NInputNumber v-model:value="s.bufferLimit" :min="100" :max="100000" :step="500" style="width: 100%" />
          </NFormItem>
        </NForm>

        <!-- ========== 显示 ========== -->
        <NForm v-if="activeTab === 'display'" label-placement="top" size="small">
          <div class="section-title">显示</div>
          <NFormItem label="默认视图">
            <NSelect v-model:value="s.defaultView" :options="viewOptions" />
          </NFormItem>
          <NFormItem label="主题">
            <NSelect v-model:value="s.theme" :options="themeOptions" />
          </NFormItem>
          <NFormItem label="字号 (px)">
            <NInputNumber v-model:value="s.fontSize" :min="10" :max="20" style="width: 100%" />
          </NFormItem>
          <NFormItem label="暂停提示">
            <NSwitch v-model:value="s.showPauseNotification">
              <template #checked>恢复时提示缺失数据时间段</template>
              <template #unchecked>不提示</template>
            </NSwitch>
          </NFormItem>
        </NForm>

        <!-- ========== 波形解析 ========== -->
        <NForm v-if="activeTab === 'waveform'" label-placement="top" size="small">
          <div class="section-title">波形解析</div>
          <NFormItem label="数值类型">
            <NSelect v-model:value="s.waveform.parse.type" :options="numericTypeOptions" />
          </NFormItem>
          <NFormItem label="字节序">
            <NSwitch v-model:value="s.waveform.parse.littleEndian">
              <template #checked>小端 LE</template>
              <template #unchecked>大端 BE</template>
            </NSwitch>
          </NFormItem>
          <NFormItem label="通道数">
            <NInputNumber
              v-model:value="s.waveform.parse.channels"
              :min="1"
              :max="16"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem label="字节偏移（帧头）">
            <NInputNumber
              v-model:value="s.waveform.parse.byteOffset"
              :min="0"
              :max="64"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem label="采样率 (Hz)">
            <NInputNumber
              v-model:value="s.waveform.sampleRate"
              :min="1"
              :max="100000"
              :step="10"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem label="最大点数">
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
          <div class="section-title">连接</div>
          <NFormItem label="掉线自动重连（阶段 2 生效）">
            <NSwitch v-model:value="s.autoReconnect" />
          </NFormItem>
        </NForm>

        <!-- ========== 自定义波特率 ========== -->
        <div v-if="activeTab === 'baud'" class="baud-section">
          <div class="section-title">自定义波特率</div>
          <div v-if="serial.customBaudRates.length === 0" class="empty-hint">
            在连接栏波特率框输入新数值即可添加；预设档位不可删除。
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
              placeholder="标注（可选）"
              @update:value="(v: string) => serial.updateCustomBaudNote(item.baud, v)"
            />
            <NButton
              size="small"
              quaternary
              type="error"
              @click="serial.removeCustomBaudRate(item.baud)"
            >
              删除
            </NButton>
          </div>
        </div>

        <!-- ========== 模拟数据 ========== -->
        <div v-if="activeTab === 'mock'" class="mock-section">
          <div class="section-title">模拟数据（阶段 1）</div>
          <NForm label-placement="top" size="small">
            <NFormItem label="注入内容">
              <NSelect v-model:value="injectMode" :options="injectModeOptions" style="width: 100px" />
            </NFormItem>
            <NFormItem>
              <div style="display: flex; gap: 8px; width: 100%">
                <input v-model="injectText" class="inject-input" />
                <NButton size="small" type="primary" @click="doInject">注入</NButton>
              </div>
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
.mock-section {
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

/* ===== 注入输入框 ===== */
.inject-input {
  flex: 1;
  font-family: var(--mono-font);
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

/* ===== NForm 内间距微调 ===== */
/* NModal preset="card" + teleport 打断 data-v 作用域链，scoped :deep() 穿不透，此处用 :global() */
:global(.n-form-item) {
  margin-bottom: 12px;
}
</style>
