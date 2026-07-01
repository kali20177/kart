<script setup lang="ts">
import {
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NSelect,
  NInputNumber,
  NSwitch,
  NButton,
  NDivider,
  useMessage
} from 'naive-ui'
import { useSettingsStore } from '@/stores/settings'
import { useSerialStore } from '@/stores/serial'
import { parseHexInput } from '@/utils/hex'
import { ref } from 'vue'

const show = defineModel<boolean>('show', { default: false })
const settingsStore = useSettingsStore()
const serial = useSerialStore()
const message = useMessage()
const s = settingsStore.settings

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
</script>

<template>
  <NDrawer v-model:show="show" :width="380" placement="right">
    <NDrawerContent title="设置" closable>
      <NForm label-placement="top" size="small">
        <NDivider title-placement="left">接收</NDivider>
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

        <NDivider title-placement="left">显示</NDivider>
        <NFormItem label="默认视图">
          <NSelect v-model:value="s.defaultView" :options="viewOptions" />
        </NFormItem>
        <NFormItem label="主题">
          <NSelect v-model:value="s.theme" :options="themeOptions" />
        </NFormItem>
        <NFormItem label="字号 (px)">
          <NInputNumber v-model:value="s.fontSize" :min="10" :max="20" style="width: 100%" />
        </NFormItem>

        <NDivider title-placement="left">波形解析</NDivider>
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

        <NDivider title-placement="left">连接</NDivider>
        <NFormItem label="掉线自动重连（阶段 2 生效）">
          <NSwitch v-model:value="s.autoReconnect" />
        </NFormItem>

        <NDivider title-placement="left">模拟数据（阶段 1）</NDivider>
        <NFormItem label="注入内容">
          <NSelect v-model:value="injectMode" :options="injectModeOptions" style="width: 100px; margin-right: 8px" />
        </NFormItem>
        <NFormItem>
          <div style="display: flex; gap: 8px; width: 100%">
            <input v-model="injectText" class="inject-input" />
            <NButton size="small" type="primary" @click="doInject">注入</NButton>
          </div>
        </NFormItem>
      </NForm>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
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
</style>
