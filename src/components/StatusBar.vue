<script setup lang="ts">
import { computed } from 'vue'
import { useSerialStore } from '@/stores/serial'

const serial = useSerialStore()

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const signalList = computed(() => [
  { key: 'DCD', on: serial.signals.dcd },
  { key: 'CTS', on: serial.signals.cts },
  { key: 'DSR', on: serial.signals.dsr },
  { key: 'RI', on: serial.signals.ri }
])
</script>

<template>
  <div class="status">
    <span class="led" :class="{ on: serial.connected }" />
    <span class="port">{{ serial.connected ? serial.selectedPort : '未连接' }}</span>
    <span v-if="serial.connected" class="summary">{{ serial.summary }}</span>

    <div class="spacer" />

    <span class="counter">RX {{ fmtBytes(serial.rxBytes) }}</span>
    <span class="counter">TX {{ fmtBytes(serial.txBytes) }}</span>

    <div class="divider" />

    <span v-for="s in signalList" :key="s.key" class="signal" :class="{ active: s.on }">
      {{ s.key }}
    </span>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  color: var(--text-dim);
}
.led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
}
.led.on {
  background: var(--ok);
  box-shadow: 0 0 5px var(--ok);
}
.port {
  color: var(--text);
  font-family: var(--mono-font);
}
.summary {
  font-family: var(--mono-font);
}
.spacer {
  flex: 1;
}
.counter {
  font-family: var(--mono-font);
}
.divider {
  width: 1px;
  height: 14px;
  background: var(--border);
}
.signal {
  font-family: var(--mono-font);
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.signal.active {
  color: var(--ok);
  border-color: var(--ok);
}
</style>
