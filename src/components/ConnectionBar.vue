<script setup lang="ts">
import { computed } from 'vue'
import { NSelect, NButton, NTooltip } from 'naive-ui'
import { useSerialStore } from '@/stores/serial'
import { SCENARIOS } from '@/mock/scenarios'
import type { MockScenarioId } from '@/types'

const emit = defineEmits<{
  (e: 'open-ascii'): void
  (e: 'open-settings'): void
}>()

const serial = useSerialStore()

const portOptions = computed(() => serial.ports.map((p) => ({ label: p, value: p })))
const baudOptions = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => ({
  label: String(b),
  value: b
}))
const dataBitsOptions = [
  { label: '8', value: 8 },
  { label: '7', value: 7 }
]
const stopBitsOptions = [
  { label: '1', value: 1 },
  { label: '2', value: 2 }
]
const parityOptions = [
  { label: 'None', value: 'none' },
  { label: 'Even', value: 'even' },
  { label: 'Odd', value: 'odd' }
]
const scenarioOptions = SCENARIOS.map((s) => ({ label: s.label, value: s.id }))

async function toggle() {
  if (serial.connected) await serial.disconnect()
  else await serial.connect()
}
</script>

<template>
  <div class="bar">
    <NSelect
      v-model:value="serial.selectedPort"
      :options="portOptions"
      size="small"
      placeholder="选择端口"
      style="width: 130px"
      :disabled="serial.connected"
    />
    <NTooltip>
      <template #trigger>
        <NButton size="small" :disabled="serial.connected" @click="serial.refreshPorts()">⟳</NButton>
      </template>
      刷新端口列表
    </NTooltip>

    <NSelect
      v-model:value="serial.options.baudRate"
      :options="baudOptions"
      size="small"
      style="width: 100px"
      :disabled="serial.connected"
    />
    <NSelect
      v-model:value="serial.options.dataBits"
      :options="dataBitsOptions"
      size="small"
      style="width: 64px"
      :disabled="serial.connected"
    />
    <NSelect
      v-model:value="serial.options.parity"
      :options="parityOptions"
      size="small"
      style="width: 86px"
      :disabled="serial.connected"
    />
    <NSelect
      v-model:value="serial.options.stopBits"
      :options="stopBitsOptions"
      size="small"
      style="width: 64px"
      :disabled="serial.connected"
    />

    <NButton
      size="small"
      :type="serial.connected ? 'error' : 'primary'"
      strong
      @click="toggle"
    >
      {{ serial.connected ? '断开' : '连接' }}
    </NButton>

    <div class="divider" />

    <span class="mock-label">模拟场景</span>
    <NSelect
      :value="serial.scenario"
      :options="scenarioOptions"
      size="small"
      style="width: 150px"
      @update:value="(v: MockScenarioId) => serial.setScenario(v)"
    />

    <div class="spacer" />

    <NButton size="small" quaternary @click="emit('open-ascii')">ASCII 表</NButton>
    <NButton size="small" quaternary @click="emit('open-settings')">设置</NButton>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}
.mock-label {
  font-size: 12px;
  color: var(--text-dim);
}
.spacer {
  flex: 1;
}
</style>
