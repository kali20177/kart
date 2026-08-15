<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  NButton,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NColorPicker,
  NDropdown,
  useMessage
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useActiveSession } from '@/composables/useSession'
import { useCommandsStore } from '@/stores/commands'
import { useSendHistory } from '@/composables/useSendHistory'
import type { DataMode, LineEnding, QuickCommand } from '@/types'

const sendHistory = useSendHistory()

const emit = defineEmits<{
  (e: 'to-composer', payload: { text: string; mode: DataMode }): void
}>()

const store = useCommandsStore()
// useActiveSession 返回活动会话 ref，用 computed 派生 serial/checksum：切 tab 时
// 快速命令从当前活动 tab 的串口发出，校验继承该会话的默认发送校验（会话级）。
const activeSession = useActiveSession()
const serial = computed(() => activeSession.value.serial)
const checksum = computed(() => activeSession.value.checksum)
const message = useMessage()
const { t } = useI18n()

const modeOptions = [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
]
const endingOptions = [
  { label: t('commands.inherit'), value: 'inherit' },
  { label: t('composer.none'), value: 'none' },
  { label: '\\r', value: 'cr' },
  { label: '\\n', value: 'lf' },
  { label: '\\r\\n', value: 'crlf' }
]
const checksumOptions = computed(() => [
  { label: t('checksum.inheritDefault'), value: 'inherit' },
  { label: t('checksum.algo.none'), value: 'none' },
  { label: t('checksum.algo.sum8'), value: 'sum8' },
  { label: t('checksum.algo.xor8'), value: 'xor8' },
  { label: t('checksum.algo.crc16-modbus'), value: 'crc16-modbus' },
  { label: t('checksum.algo.crc32'), value: 'crc32' }
])

// 编辑弹窗
const showEdit = ref(false)
const editing = ref<QuickCommand>(blank())
const isNew = ref(true)

function blank(): QuickCommand {
  return { id: '', name: '', payload: '', mode: 'ascii', appendNewline: 'crlf', color: '#2080f0', checksum: 'inherit' }
}

function openNew() {
  editing.value = blank()
  isNew.value = true
  showEdit.value = true
}
function openEdit(c: QuickCommand) {
  editing.value = { ...c }
  isNew.value = false
  showEdit.value = true
}
function saveEdit() {
  if (!editing.value.name.trim()) {
    message.warning(t('commands.needName'))
    return
  }
  if (isNew.value) {
    const { id: _id, ...rest } = editing.value
    void _id
    store.add(rest)
  } else {
    store.update(editing.value.id, editing.value)
  }
  showEdit.value = false
}

async function sendCmd(c: QuickCommand) {
  const ending: LineEnding = c.appendNewline === 'inherit' ? 'crlf' : c.appendNewline
  const cs = !c.checksum || c.checksum === 'inherit' ? checksum.value.send : c.checksum
  const r = await serial.value.send(c.payload, c.mode, ending, 'utf-8', cs)
  if (!r.ok) message.error(r.error ?? t('commands.sendFailed'))
  else sendHistory.add(c.payload)
}

function menuOptions(c: QuickCommand) {
  return [
    { label: t('commands.edit'), key: 'edit' },
    { label: t('commands.toComposer'), key: 'to-composer' },
    { label: t('commands.duplicate'), key: 'dup' },
    { label: t('commands.delete'), key: 'del' }
  ].map((o) => ({ ...o, cmd: c }))
}
function onMenu(key: string, c: QuickCommand) {
  if (key === 'edit') openEdit(c)
  else if (key === 'dup') store.duplicate(c.id)
  else if (key === 'del') store.remove(c.id)
  else if (key === 'to-composer') emit('to-composer', { text: c.payload, mode: c.mode })
}

// 拖拽排序
const dragIndex = ref<number | null>(null)
function onDrop(to: number) {
  if (dragIndex.value != null) store.move(dragIndex.value, to)
  dragIndex.value = null
}

// 导入导出
async function doExport() {
  const content = store.exportJson()
  if (window.kart?.saveTextFile) {
    await window.kart.saveTextFile(content, 'quick-commands.json')
    return
  }
  const blob = new Blob([content], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'quick-commands.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
const fileInput = ref<HTMLInputElement | null>(null)
function doImportClick() {
  fileInput.value?.click()
}
function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    const r = store.importJson(String(reader.result))
    if (r.ok) message.success(t('commands.importOk'))
    else message.error(r.error ?? t('commands.importFail'))
  }
  reader.readAsText(f)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="panel">
    <div class="head">
      <span class="title">{{ t('commands.title') }}</span>
      <div class="head-actions">
        <button type="button" class="icon-btn" :aria-label="t('commands.import')" @click="doImportClick">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 13.5h12" />
            <path d="M8 3v8" />
            <path d="M4.5 7.5 8 11l3.5-3.5" />
          </svg>
        </button>
        <button type="button" class="icon-btn" :aria-label="t('commands.export')" @click="doExport">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 13.5h12" />
            <path d="M8 11V3" />
            <path d="M4.5 6.5 8 3l3.5 3.5" />
          </svg>
        </button>
      </div>
    </div>

    <input ref="fileInput" type="file" accept="application/json" hidden @change="onFile" />

    <div class="list">
      <button type="button" class="add-card" :aria-label="t('commands.newCmd')" @click="openNew">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <div
        v-for="(c, i) in store.commands"
        :key="c.id"
        class="item"
        draggable="true"
        @dragstart="dragIndex = i"
        @dragover.prevent
        @drop="onDrop(i)"
      >
        <span class="dot" :style="{ background: c.color || 'var(--accent)' }" />
        <div class="info" @click="sendCmd(c)">
          <div class="name">{{ c.name }}</div>
          <div class="payload">
            <span class="tag">{{ c.mode.toUpperCase() }}</span>{{ c.payload }}
          </div>
        </div>
        <NDropdown
          trigger="click"
          :options="menuOptions(c)"
          @select="(key: string) => onMenu(key, c)"
        >
          <NButton size="tiny" quaternary>⋯</NButton>
        </NDropdown>
      </div>
      <div v-if="store.commands.length === 0" class="empty">{{ t('commands.empty') }}</div>
    </div>

    <NModal
      v-model:show="showEdit"
      preset="card"
      :title="isNew ? t('commands.newCmd') : t('commands.editCmd')"
      style="width: 420px"
    >
      <NForm label-placement="left" label-width="72">
        <NFormItem :label="t('commands.name')">
          <NInput v-model:value="editing.name" :placeholder="t('commands.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('commands.content')">
          <NInput v-model:value="editing.payload" :placeholder="t('commands.payloadPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('commands.mode')">
          <NSelect v-model:value="editing.mode" :options="modeOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.lineEnding')">
          <NSelect v-model:value="editing.appendNewline" :options="endingOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.checksum')">
          <NSelect v-model:value="editing.checksum" :options="checksumOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.color')">
          <NColorPicker v-model:value="editing.color" :show-alpha="false" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <NButton @click="showEdit = false">{{ t('commands.cancel') }}</NButton>
          <NButton type="primary" @click="saveEdit">{{ t('commands.save') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--glass-border);
}
.title {
  font-weight: 600;
  font-size: 13px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.icon-btn svg {
  width: 14px;
  height: 14px;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.add-card {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 38px;
  margin-bottom: 6px;
  border: 1px dashed var(--glass-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.add-card:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.04);
}
.add-card svg {
  width: 18px;
  height: 18px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius);
  cursor: grab;
}
.item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.name {
  font-size: 13px;
}
.payload {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono-font);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  display: inline-block;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: 0 3px;
  margin-right: 5px;
  font-size: 10px;
}
.empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 24px 0;
}
</style>
