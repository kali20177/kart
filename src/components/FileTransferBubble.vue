<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { FileTransferState, TransferStatus } from '@/types'
import { useSession } from '@/composables/useSession'
import { formatTimestamp } from '@/utils/message-format'

const props = defineProps<{
  transferId: string
  timestamp: number
}>()

const { t } = useI18n()
const toast = useMessage()
const { transfer: transferStore } = useSession()

/** 实时从 transfer store 读取状态 */
const state = computed<FileTransferState | null>(() => {
  return transferStore.getTransfer(props.transferId) ?? null
})

const timeLabel = computed(() => formatTimestamp(props.timestamp, 'short'))

const statusLabel = computed(() => {
  if (!state.value) return ''
  return t(`fileTransfer.status.${state.value.status}`)
})

const isActive = computed(() =>
  state.value?.status === 'sending' || state.value?.status === 'paused'
)

const progressPercent = computed(() => {
  if (!state.value || state.value.total === 0) return 0
  return Math.round((state.value.sent / state.value.total) * 100)
})

const progressStyle = computed(() => ({
  width: `${progressPercent.value}%`
}))

const eta = computed(() => {
  if (!state.value || state.value.bytesPerSec <= 0 || state.value.status === 'completed') return ''
  const remaining = state.value.total - state.value.sent
  const secs = Math.ceil(remaining / state.value.bytesPerSec)
  if (secs < 60) return t('fileTransfer.etaSec', { s: secs })
  return t('fileTransfer.etaMin', { m: Math.ceil(secs / 60) })
})

const statusColor = computed(() => {
  const map: Record<TransferStatus, string> = {
    queued: 'var(--text-dim)',
    sending: 'var(--accent)',
    paused: 'var(--warn)',
    completed: 'var(--ok)',
    aborted: 'var(--text-dim)',
    error: 'var(--err)'
  }
  return map[state.value?.status ?? 'queued']
})

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function onPause() {
  if (state.value) transferStore.pause(state.value.id)
}

function onResume() {
  if (state.value) transferStore.resume(state.value.id)
}

function onAbort() {
  if (state.value) transferStore.abort(state.value.id)
}

function onRetry() {
  if (state.value) transferStore.retry(state.value.id)
}

function onDetails() {
  const s = state.value
  if (!s) return
  const lines = [
    `${t('fileTransfer.detailFile')}: ${s.filename}`,
    `${t('fileTransfer.detailSize')}: ${fmtBytes(s.size)}`,
    `${t('fileTransfer.detailSent')}: ${fmtBytes(s.sent)} / ${fmtBytes(s.total)}`,
    `${t('fileTransfer.detailChunks')}: ${s.currentChunk} / ${s.totalChunks}`,
    `${t('fileTransfer.detailStatus')}: ${statusLabel.value}`,
    `${t('fileTransfer.detailRate')}: ${fmtBytes(s.bytesPerSec)}/s`,
    `${t('fileTransfer.detailElapsed')}: ${fmtTime(s.elapsedMs)}`
  ]
  if (s.failedChunk !== undefined) {
    lines.push(`${t('fileTransfer.detailFailedChunk')}: ${s.failedChunk}`)
  }
  if (s.error) {
    lines.push(`${t('fileTransfer.detailError')}: ${s.error}`)
  }
  toast.info(lines.join('\n'), { duration: 5000, closable: true })
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
</script>

<template>
  <div class="file-bubble" v-if="state">
    <!-- 头部：文件名 + 状态 -->
    <div class="file-header">
      <span class="file-icon">📎</span>
      <span class="file-name">{{ state.filename }}</span>
      <span class="file-size">{{ fmtBytes(state.size) }}</span>
      <span class="time">{{ timeLabel }}</span>
    </div>

    <!-- 进度条 -->
    <div class="progress-bar">
      <div class="progress-fill" :style="progressStyle" />
    </div>
    <div class="progress-label">
      {{ progressPercent }}%
    </div>

    <!-- 统计信息 -->
    <div class="stats">
      <span class="stat-chunks">
        {{ state.currentChunk }}/{{ state.totalChunks }}
        <span class="stat-label">{{ t('fileTransfer.chunks') }}</span>
      </span>
      <span class="stat-rate">
        {{ fmtBytes(state.bytesPerSec) }}/s
      </span>
      <span v-if="eta" class="stat-eta">
        {{ t('fileTransfer.eta') }} {{ eta }}
      </span>
      <span class="stat-pass" v-if="state.pass > 1">
        {{ t('fileTransfer.pass') }} {{ state.pass }}
      </span>
    </div>

    <!-- 状态徽章 -->
    <div class="status-badge" :style="{ color: statusColor }">
      <span class="status-dot" :style="{ background: statusColor }" />
      {{ statusLabel }}
    </div>

    <!-- 操作按钮 -->
    <div class="actions" v-if="isActive || state.status === 'completed' || state.status === 'error' || state.status === 'aborted'">
      <template v-if="state.status === 'sending'">
        <button class="action-btn" :title="t('fileTransfer.pause')" @click="onPause">
          ⏸ {{ t('fileTransfer.pause') }}
        </button>
        <button class="action-btn" :title="t('fileTransfer.abort')" @click="onAbort">
          ⏹ {{ t('fileTransfer.abort') }}
        </button>
      </template>
      <template v-else-if="state.status === 'paused'">
        <button class="action-btn" :title="t('fileTransfer.resume')" @click="onResume">
          ▶ {{ t('fileTransfer.resume') }}
        </button>
        <button class="action-btn" :title="t('fileTransfer.abort')" @click="onAbort">
          ⏹ {{ t('fileTransfer.abort') }}
        </button>
      </template>
      <template v-else-if="state.status === 'completed' || state.status === 'error' || state.status === 'aborted'">
        <button class="action-btn" :title="t('fileTransfer.retry')" @click="onRetry">
          ↻ {{ t('fileTransfer.retry') }}
        </button>
      </template>
      <button class="action-btn" :title="t('fileTransfer.details')" @click="onDetails">
        📋 {{ t('fileTransfer.details') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.file-bubble {
  padding: 8px 10px;
  min-width: 240px;
  max-width: 340px;
}

.file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 6px;
}

.file-icon {
  font-size: 16px;
}

.file-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono-font);
}

.time {
  font-size: 11px;
  color: var(--text-dim);
  margin-left: auto;
  white-space: nowrap;
}

/* 进度条 */
.progress-bar {
  height: 8px;
  background: var(--bg-elevated);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 4px;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.15s ease;
}

.progress-label {
  font-size: 12px;
  font-family: var(--mono-font);
  text-align: right;
  color: var(--text-dim);
  margin-bottom: 4px;
}

/* 统计信息 */
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  font-family: var(--mono-font);
  color: var(--text-dim);
  margin-bottom: 6px;
}

.stat-label {
  font-size: 10px;
  font-family: var(--ui-font);
}

/* 状态徽章 */
.status-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

/* 操作按钮 */
.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.action-btn {
  font-size: 11px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  cursor: pointer;
  white-space: nowrap;
}

.action-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>