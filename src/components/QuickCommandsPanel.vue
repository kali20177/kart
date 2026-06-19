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
import { useCommandsStore } from '@/stores/commands'
import { useSerialStore } from '@/stores/serial'
import type { DataMode, LineEnding, QuickCommand } from '@/types'

const emit = defineEmits<{
  (e: 'to-composer', payload: { text: string; mode: DataMode }): void
}>()

const store = useCommandsStore()
const serial = useSerialStore()
const message = useMessage()

const modeOptions = [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
]
const endingOptions = [
  { label: '沿用发送框', value: 'inherit' },
  { label: '无', value: 'none' },
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
    message.warning('请填写名称')
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
  if (!r.ok) message.error(r.error ?? '发送失败')
}

function menuOptions(c: QuickCommand) {
  return [
    { label: '编辑', key: 'edit' },
    { label: '调到发送框', key: 'to-composer' },
    { label: '复制', key: 'dup' },
    { label: '删除', key: 'del' }
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
    if (r.ok) message.success('导入成功')
    else message.error(r.error ?? '导入失败')
  }
  reader.readAsText(f)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="panel">
    <div class="head">
      <span class="title">快速命令</span>
      <NButton size="tiny" @click="openNew">+ 新建</NButton>
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
      <div v-if="store.commands.length === 0" class="empty">暂无命令，点击「新建」添加</div>
    </div>

    <div class="foot">
      <NButton size="tiny" @click="doImportClick">导入</NButton>
      <NButton size="tiny" @click="doExport">导出</NButton>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onFile" />
    </div>

    <NModal
      v-model:show="showEdit"
      preset="card"
      :title="isNew ? '新建命令' : '编辑命令'"
      style="width: 420px"
    >
      <NForm label-placement="left" label-width="72">
        <NFormItem label="名称">
          <NInput v-model:value="editing.name" placeholder="如：查询信号质量" />
        </NFormItem>
        <NFormItem label="内容">
          <NInput v-model:value="editing.payload" placeholder="ASCII 文本或 HEX 字节" />
        </NFormItem>
        <NFormItem label="模式">
          <NSelect v-model:value="editing.mode" :options="modeOptions" />
        </NFormItem>
        <NFormItem label="行尾">
          <NSelect v-model:value="editing.appendNewline" :options="endingOptions" />
        </NFormItem>
        <NFormItem label="标签色">
          <NColorPicker v-model:value="editing.color" :show-alpha="false" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <NButton @click="showEdit = false">取消</NButton>
          <NButton type="primary" @click="saveEdit">保存</NButton>
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
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
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
  background: var(--bg-elevated);
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
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 3px;
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
  border-top: 1px solid var(--border);
}
</style>
