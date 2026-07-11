<script setup lang="ts">
import { NButton, NPopover, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSendHistory } from '@/composables/useSendHistory'

const emit = defineEmits<{
  (e: 'to-composer', text: string): void
}>()

const { t } = useI18n()
const dialog = useDialog()
const history = useSendHistory()

function insertEntry(text: string) {
  emit('to-composer', text)
}

function deleteEntry(index: number) {
  history.remove(index)
}

function clearAll() {
  if (history.history.value.length === 0) return
  dialog.warning({
    title: t('msgList.history'),
    content: t('msgList.historyClearConfirm'),
    positiveText: t('msgList.historyClearOk'),
    negativeText: t('msgList.historyClearCancel'),
    onPositiveClick: () => {
      history.clear()
    }
  })
}
</script>

<template>
  <NPopover
    trigger="click"
    placement="bottom-end"
    :width="360"
    :show-arrow="false"
    :style="{ padding: 0 }"
  >
    <template #trigger>
      <NButton
        size="tiny"
        quaternary
        :title="t('msgList.history')"
        :class="{ 'has-items': history.history.value.length > 0 }"
      >
        <span class="hist-btn">
          📋
          <span v-if="history.history.value.length > 0" class="hist-badge">
            {{ history.history.value.length }}
          </span>
        </span>
      </NButton>
    </template>

    <div class="hist-panel">
      <div class="hist-header">
        <span class="hist-title">{{ t('msgList.history') }}</span>
        <span class="hist-count">{{ history.history.value.length }} {{ t('msgList.frames') }}</span>
      </div>

      <div class="hist-list">
        <div
          v-for="(entry, idx) in history.history.value"
          :key="idx"
          class="hist-item"
        >
          <span
            class="hist-text"
            :title="entry"
            @click="insertEntry(entry)"
          >
            {{ entry }}
          </span>
          <div class="hist-actions">
            <NButton
              size="tiny"
              quaternary
              :title="t('msgList.historyInsert')"
              @click.stop="insertEntry(entry)"
            >
              →
            </NButton>
            <NButton
              size="tiny"
              quaternary
              circle
              :title="t('msgList.delete')"
              @click.stop="deleteEntry(idx)"
            >
              ✕
            </NButton>
          </div>
        </div>
        <div v-if="history.history.value.length === 0" class="hist-empty">
          {{ t('msgList.historyEmpty') }}
        </div>
      </div>

      <div v-if="history.history.value.length > 0" class="hist-footer">
        <NButton size="tiny" quaternary type="error" @click="clearAll">
          {{ t('msgList.historyClearAll') }}
        </NButton>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.hist-panel {
  display: flex;
  flex-direction: column;
  max-height: 400px;
}
.hist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.hist-title {
  font-weight: 600;
  font-size: 13px;
}
.hist-count {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono-font);
}
.hist-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.hist-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--glass-border);
  transition: background 0.12s;
}
.hist-item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.hist-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-family: var(--mono-font);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  color: var(--text);
  padding: 2px 0;
}
.hist-text:hover {
  color: var(--accent);
}
.hist-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0.4;
  transition: opacity 0.12s;
}
.hist-item:hover .hist-actions {
  opacity: 1;
}
.hist-empty {
  text-align: center;
  padding: 24px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.hist-footer {
  display: flex;
  justify-content: flex-end;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.hist-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.hist-badge {
  position: absolute;
  top: -6px;
  right: -8px;
  font-size: 9px;
  font-weight: 700;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  padding: 0 4px;
  line-height: 1.4;
  min-width: 14px;
  text-align: center;
  pointer-events: none;
}
</style>