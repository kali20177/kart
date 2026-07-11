<script setup lang="ts">
import { ref } from 'vue'
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
import { useCommandsStore } from '@/stores/commands'
import { useSerialStore } from '@/stores/serial'
import { useSendHistory } from '@/composables/useSendHistory'
import type { DataMode, LineEnding, QuickCommand } from '@/types'

const sendHistory = useSendHistory()

const emit = defineEmits<{
  (e: 'to-composer', payload: { text: string; mode: DataMode }): void
}>()

const store = useCommandsStore()
const serial = useSerialStore()
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

// 编辑弹窗
const showEdit = ref(false)
const editing = ref<QuickCommand>(blank())
const isNew = ref(true)

function blank(): QuickCommand {
  return { id: '', name: '', payload: '', mode: 'ascii', appendNewline: 'crlf', color: '#2080f0' }
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
  const r = await serial.send(c.payload, c.mode, ending, 'utf-8')
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
function doExport() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' })
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
      <NButton size="tiny" @click="openNew">{{ t('commands.new') }}</NButton>
    </div>

    <div class="list">
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

    <div class="foot">
      <NButton size="tiny" @click="doImportClick">{{ t('commands.import') }}</NButton>
      <NButton size="tiny" @click="doExport">{{ t('commands.export') }}</NButton>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onFile" />
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
.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
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
.foot {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--glass-border);
}
</style>
