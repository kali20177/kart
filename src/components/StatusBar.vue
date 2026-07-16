<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useSerialStore } from '@/stores/serial'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import { useTransferStore } from '@/stores/transfer'
import { useI18n } from 'vue-i18n'

const serial = useSerialStore()
const messages = useMessagesStore()
const settings = useSettingsStore()
const transferStore = useTransferStore()
const { t } = useI18n()

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtRate(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return `${n}/s`
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}K/s`
  return `${(n / 1_000_000).toFixed(2)}M/s`
}

// ── 会话时长 ──
const sessionDuration = ref('')
const frozenDuration = ref('')
let durationTimer: ReturnType<typeof setInterval> | null = null

function formatDuration(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000)
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function updateDuration() {
  if (serial.sessionStartedAt) {
    sessionDuration.value = formatDuration(serial.sessionStartedAt)
  }
}

// ── 速率（每秒采样，1s 间隔）──
const rxBytesRate = ref(0)
const txBytesRate = ref(0)
const rxFramesRate = ref(0)
const txFramesRate = ref(0)

let lastRxBytes = 0
let lastTxBytes = 0
let lastRxFrames = 0
let lastTxFrames = 0
let lastRateTime = 0
let rateTimer: ReturnType<typeof setInterval> | null = null

function updateRates() {
  const now = Date.now()
  const dt = Math.max((now - lastRateTime) / 1000, 0.1)
  rxBytesRate.value = Math.round((serial.rxBytes - lastRxBytes) / dt)
  txBytesRate.value = Math.round((serial.txBytes - lastTxBytes) / dt)
  rxFramesRate.value = Math.round((messages.rxFrames - lastRxFrames) / dt)
  txFramesRate.value = Math.round((messages.txFrames - lastTxFrames) / dt)
  lastRxBytes = serial.rxBytes
  lastTxBytes = serial.txBytes
  lastRxFrames = messages.rxFrames
  lastTxFrames = messages.txFrames
  lastRateTime = now
}

// 曾经连接过（至少一次），断开后冻结统计而非消失
const hasSessionData = ref(false)

function startTimers() {
  lastRxBytes = serial.rxBytes
  lastTxBytes = serial.txBytes
  lastRxFrames = messages.rxFrames
  lastTxFrames = messages.txFrames
  lastRateTime = Date.now()
  updateDuration()
  durationTimer = setInterval(updateDuration, 1000)
  rateTimer = setInterval(updateRates, 1000)
}

function stopTimers() {
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null }
  if (rateTimer) { clearInterval(rateTimer); rateTimer = null }
}

watch(() => serial.connected, (c) => {
  if (c) {
    hasSessionData.value = true
    startTimers()
  } else {
    // 冻结当前时长，保留最后一次读数
    if (serial.sessionStartedAt) {
      frozenDuration.value = formatDuration(serial.sessionStartedAt)
    } else {
      frozenDuration.value = sessionDuration.value
    }
    stopTimers()
  }
}, { immediate: true })

onBeforeUnmount(() => stopTimers())

// ── 缓冲使用率 ──
const bufferPct = computed(() => {
  const limit = settings.settings.bufferLimit
  if (limit <= 0) return 0
  return Math.round((messages.messages.length / limit) * 100)
})

const bufferWarning = computed(() => bufferPct.value >= 80)

const signalList = computed(() => [
  { key: 'DCD', on: serial.signals.dcd },
  { key: 'CTS', on: serial.signals.cts },
  { key: 'DSR', on: serial.signals.dsr },
  { key: 'RI', on: serial.signals.ri }
])
</script>

<template>
  <div class="status">
    <!-- 连接指示 -->
    <span class="led" :class="{ on: serial.connected }" />
    <span class="port" :class="{ stale: hasSessionData && !serial.connected }">
      {{ serial.connected || hasSessionData ? serial.selectedPort : t('status.notConnected') }}
    </span>
    <span v-if="serial.connected || hasSessionData" class="summary" :class="{ stale: !serial.connected }">
      {{ serial.summary }}
    </span>

    <!-- 统计（首次连接后始终可见，断开后灰度冻结） -->
    <template v-if="hasSessionData">
      <div class="divider" />

      <span class="stat" :class="{ stale: !serial.connected }" :title="t('status.sessionDuration')">
        <span class="stat-icon">⏱</span>{{ serial.connected ? sessionDuration : frozenDuration }}
      </span>

      <div class="divider" />

      <span class="stat-group" :class="{ stale: !serial.connected }" :title="t('status.rxFramesTip')">
        <span class="dir-label rx">RX</span>
        <span class="val">{{ fmtCount(messages.rxFrames) }}f</span>
        <span v-if="serial.connected && rxFramesRate > 0" class="rate">{{ fmtRate(rxFramesRate) }}</span>
      </span>

      <span class="stat-group" :class="{ stale: !serial.connected }" :title="t('status.txFramesTip')">
        <span class="dir-label tx">TX</span>
        <span class="val">{{ fmtCount(messages.txFrames) }}f</span>
        <span v-if="serial.connected && txFramesRate > 0" class="rate">{{ fmtRate(txFramesRate) }}</span>
      </span>

      <span class="stat-group" :class="{ stale: !serial.connected }" :title="t('status.rxBytesTip')">
        <span class="dir-label rx">RX</span>
        <span class="val">{{ fmtBytes(serial.rxBytes) }}</span>
        <span v-if="serial.connected && rxBytesRate > 0" class="rate">{{ fmtBytes(rxBytesRate) }}/s</span>
      </span>

      <span class="stat-group" :class="{ stale: !serial.connected }" :title="t('status.txBytesTip')">
        <span class="dir-label tx">TX</span>
        <span class="val">{{ fmtBytes(serial.txBytes) }}</span>
        <span v-if="serial.connected && txBytesRate > 0" class="rate">{{ fmtBytes(txBytesRate) }}/s</span>
      </span>

      <span
        class="stat-group buffer"
        :class="{ warn: serial.connected && bufferWarning, stale: !serial.connected }"
        :title="t('status.bufferTip', { used: messages.messages.length, limit: settings.settings.bufferLimit })"
      >
        <span class="dir-label">buf</span>
        <span class="val">{{ bufferPct }}%</span>
      </span>
    </template>

    <div class="spacer" />

    <!-- 活跃下发指示 -->
    <template v-if="transferStore.activeTransfer">
      <span class="transfer-indicator">
        📎 {{ transferStore.activeTransfer.filename }}
        {{ Math.round((transferStore.activeTransfer.sent / transferStore.activeTransfer.total) * 100) }}%
        <span class="transfer-rate">{{ fmtBytes(transferStore.activeTransfer.bytesPerSec) }}/s</span>
      </span>
      <div class="divider" />
    </template>

    <span v-for="s in signalList" :key="s.key" class="signal" :class="{ active: s.on }">
      {{ s.key }}
    </span>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  border-top: 1px solid var(--glass-border);
  color: var(--text-dim);
}
.led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  flex: none;
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
.divider {
  width: 1px;
  height: 14px;
  background: var(--glass-border);
  flex: none;
}

/* ── 断开后灰度冻结 ── */
.stale {
  opacity: 0.45;
  transition: opacity 0.3s;
}
.stale .dir-label.rx {
  color: var(--text-dim);
  background: rgba(128, 128, 128, 0.08);
}
.stale .dir-label.tx {
  color: var(--text-dim);
  background: rgba(128, 128, 128, 0.08);
}
.stale .val {
  color: var(--text-dim);
}

/* ── 统计组 ── */
.stat {
  font-family: var(--mono-font);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.stat-icon {
  font-size: 11px;
  line-height: 1;
}
.stat-group {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  white-space: nowrap;
  font-family: var(--mono-font);
}
.dir-label {
  font-size: 10px;
  font-weight: 600;
  padding: 0 3px;
  border-radius: 2px;
  line-height: 1.4;
}
.dir-label.rx {
  color: var(--rx-text, #4da6ff);
  background: color-mix(in srgb, var(--rx-text, #4da6ff) 15%, transparent);
}
.dir-label.tx {
  color: var(--tx-text, #4ec97a);
  background: color-mix(in srgb, var(--tx-text, #4ec97a) 15%, transparent);
}
.val {
  color: var(--text);
}
.rate {
  color: var(--text-dim);
  font-size: 10px;
}

/* 缓冲指示 */
.buffer .dir-label {
  color: var(--text-dim);
  background: rgba(128, 128, 128, 0.12);
}
.buffer.warn .dir-label {
  color: var(--err, #e06060);
  background: color-mix(in srgb, var(--err, #e06060) 15%, transparent);
}
.buffer.warn .val {
  color: var(--err, #e06060);
}

.signal {
  font-family: var(--mono-font);
  font-size: 11px;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
}
.signal.active {
  color: var(--ok);
  border-color: var(--ok);
}
.transfer-indicator {
  color: var(--accent);
  font-family: var(--mono-font);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.transfer-rate {
  color: var(--text-dim);
  font-size: 11px;
}
</style>
