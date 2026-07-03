<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import { NButton, NInput, NButtonGroup, NTag, useDialog, useMessage } from 'naive-ui'
import MessageBubble from './MessageBubble.vue'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import type { DataMode, Direction, Message } from '@/types'
import { decodeBytes } from '@/utils/encoding'
import { formatMessageLine } from '@/utils/message-format'
import { downloadTextFile } from '@/utils/download'

const props = defineProps<{ viewMode: DataMode }>()
const emit = defineEmits<{ (e: 'resend', bytes: Uint8Array): void }>()

const messagesStore = useMessagesStore()
const settingsStore = useSettingsStore()
const dialog = useDialog()
const toast = useMessage()

const dirFilter = ref<'all' | Direction>('all')
const keyword = ref('')

// 多选状态：右键进入，左键切选，底部操作栏批量复制 / 导出 / 删除
const multiSelect = ref(false)
const selected = reactive(new Set<number>())
const selectedCount = computed(() => selected.size)

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return messagesStore.messages.filter((m) => {
    if (dirFilter.value !== 'all' && m.direction !== dirFilter.value) return false
    if (kw) {
      const text = decodeBytes(m.bytes, settingsStore.settings.encoding).toLowerCase()
      if (!text.includes(kw)) return false
    }
    return true
  })
})

const scroller = ref<InstanceType<typeof DynamicScroller> | null>(null)
const follow = ref(true)
let scrollEl: HTMLElement | null = null

function onScroll() {
  if (!scrollEl) return
  const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
  follow.value = dist < 48
}

function scrollToBottom() {
  const inst = scroller.value as unknown as { scrollToBottom?: () => void } | null
  inst?.scrollToBottom?.()
}

onMounted(() => {
  scrollEl = (scroller.value as unknown as { $el: HTMLElement } | null)?.$el ?? null
  scrollEl?.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => scrollEl?.removeEventListener('scroll', onScroll))

// 新数据到达：仅"跟随最新"且"非多选"时自动滚底（多选时用户在选历史，不应被滚走）
watch(
  () => messagesStore.messages.length,
  () => {
    if (follow.value && !multiSelect.value) nextTick(scrollToBottom)
  }
)

// 删除 / 清空后，清理 selected 中已不存在的 id；全空则退出多选
watch(
  () => messagesStore.messages,
  (list) => {
    if (!selected.size) return
    const ids = new Set(list.map((m) => m.id))
    for (const id of [...selected]) {
      if (!ids.has(id)) selected.delete(id)
    }
    if (multiSelect.value && !selected.size) multiSelect.value = false
  }
)

function jumpLatest() {
  follow.value = true
  nextTick(scrollToBottom)
}

// —— 多选编排 ——
function toggleSelect(id: number) {
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
}

/** 右键气泡：非多选→进入多选并选中该条；已多选→切换该条 */
function onBubbleContext(item: Message) {
  if (!multiSelect.value) {
    multiSelect.value = true
    selected.add(item.id)
  } else {
    toggleSelect(item.id)
  }
}

function onBubbleSelect(item: Message) {
  toggleSelect(item.id)
}

function selectAllVisible() {
  filtered.value.forEach((m) => selected.add(m.id))
}

function exitMultiSelect() {
  selected.clear()
  multiSelect.value = false
}

/** 按 selected 顺序取出 Message（filtered 可能不含全部，从 store 全量查） */
function selectedMessages(): Message[] {
  const byId = new Map(messagesStore.messages.map((m) => [m.id, m]))
  return [...selected].map((id) => byId.get(id)).filter((m): m is Message => !!m)
}

function copySelected() {
  const lines = selectedMessages()
    .map((m) =>
      formatMessageLine(m, {
        viewMode: props.viewMode,
        encoding: settingsStore.settings.encoding,
        timeStyle: 'short'
      })
    )
    .join('\n')
  navigator.clipboard?.writeText(lines)
  toast.success(`已复制 ${selectedCount.value} 条`)
}

function exportSelected() {
  const lines =
    selectedMessages()
      .map((m) =>
        formatMessageLine(m, {
          viewMode: props.viewMode,
          encoding: settingsStore.settings.encoding,
          timeStyle: 'full'
        })
      )
      .join('\n') + '\n'
  downloadTextFile('serial-log-selected.txt', lines)
  toast.success(`已导出 ${selectedCount.value} 条`)
}

function deleteSelected() {
  const n = selectedCount.value
  if (n === 0) return
  dialog.warning({
    title: '删除选中帧？',
    content: `将删除 ${n} 条消息，此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      messagesStore.removeByIds([...selected])
      selected.clear()
      multiSelect.value = false
    }
  })
}
</script>

<template>
  <div class="list-wrap">
    <div class="toolbar">
      <NButtonGroup size="tiny">
        <NButton :type="dirFilter === 'all' ? 'primary' : 'default'" @click="dirFilter = 'all'">全部</NButton>
        <NButton :type="dirFilter === 'rx' ? 'primary' : 'default'" @click="dirFilter = 'rx'">RX</NButton>
        <NButton :type="dirFilter === 'tx' ? 'primary' : 'default'" @click="dirFilter = 'tx'">TX</NButton>
      </NButtonGroup>
      <NInput v-model:value="keyword" size="tiny" placeholder="过滤关键字" clearable style="width: 160px" />
      <NTag size="small" :bordered="false">{{ filtered.length }} 帧</NTag>
      <div class="spacer" />
      <NButton size="tiny" :type="messagesStore.paused ? 'warning' : 'default'" @click="messagesStore.togglePause()">
        {{ messagesStore.paused ? '已暂停' : '暂停' }}
      </NButton>
      <NButton size="tiny" @click="messagesStore.clear()">清空</NButton>
    </div>

    <div class="scroll-area">
      <DynamicScroller
        ref="scroller"
        :items="filtered"
        :min-item-size="46"
        key-field="id"
        class="scroller"
        :class="{ 'with-action-bar': multiSelect }"
      >
        <template #default="{ item, index, active }">
          <DynamicScrollerItem
            :item="item"
            :active="active"
            :size-dependencies="[item.bytes.length, props.viewMode]"
            :data-index="index"
          >
            <MessageBubble
              :message="item"
              :view-mode="props.viewMode"
              :encoding="settingsStore.settings.encoding"
              :selectable="multiSelect"
              :selected="selected.has(item.id)"
              @resend="emit('resend', $event)"
              @select="onBubbleSelect(item)"
              @contextmenu="onBubbleContext(item)"
            />
          </DynamicScrollerItem>
        </template>
      </DynamicScroller>

      <Transition name="fade">
        <NButton v-if="!multiSelect && !follow" class="jump-btn" size="small" type="primary" @click="jumpLatest">
          ↓ 回到最新
        </NButton>
      </Transition>

      <!-- 多选操作栏 -->
      <div v-if="multiSelect" class="action-bar">
        <NTag size="small" :bordered="false" type="info">已选 {{ selectedCount }}</NTag>
        <NButton size="small" :disabled="selectedCount === 0" @click="copySelected">复制</NButton>
        <NButton size="small" :disabled="selectedCount === 0" @click="exportSelected">导出 txt</NButton>
        <NButton size="small" type="error" :disabled="selectedCount === 0" @click="deleteSelected">删除</NButton>
        <NButton size="small" @click="selectAllVisible">全选</NButton>
        <div class="spacer" />
        <NButton size="small" quaternary @click="exitMultiSelect">取消</NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.list-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.spacer {
  flex: 1;
}
.scroll-area {
  position: relative;
  flex: 1;
  min-height: 0;
}
.scroller {
  height: 100%;
  padding: 6px 0;
}
/* 多选时给底部留出操作栏高度，避免最后一条被遮挡 */
.scroller.with-action-bar {
  height: calc(100% - 44px);
}
.jump-btn {
  position: absolute;
  right: 18px;
  bottom: 14px;
}
.action-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  z-index: 2;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
