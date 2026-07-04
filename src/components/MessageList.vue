<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import { NButton, NInput, NButtonGroup, NTag, useDialog, useMessage } from 'naive-ui'
import MessageBubble from './MessageBubble.vue'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import { useMessageSearch } from '@/composables/useMessageSearch'
import { parseTimeInput } from '@/utils/search'
import type { DataMode, Direction, Message } from '@/types'
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
const searchMode = ref<'text' | 'hex'>('text')
const timeInputStart = ref('')
const timeInputEnd = ref('')
const showTimeFilter = ref(false)
const matchIndex = ref(0)

/** HH:MM:SS[.mmm] / HH:MM → 当日毫秒数；非法返回 null */
const timeStart = computed(() => parseTimeInput(timeInputStart.value))
const timeEnd = computed(() => parseTimeInput(timeInputEnd.value))
/** 输入非空但解析失败 → 红框提示（不静默吞） */
const timeStartInvalid = computed(() => timeInputStart.value.trim() !== '' && timeStart.value === null)
const timeEndInvalid = computed(() => timeInputEnd.value.trim() !== '' && timeEnd.value === null)

const encoding = computed(() => settingsStore.settings.encoding)

const { filtered, matchRanges, matchCount, hexError } = useMessageSearch({
  messages: computed(() => messagesStore.messages),
  keyword,
  searchMode,
  encoding,
  dirFilter,
  timeStart,
  timeEnd
})

// 任何筛选条件变化 → 导航从头开始（命中集合已变）
watch([keyword, searchMode, dirFilter, timeStart, timeEnd], () => {
  matchIndex.value = 0
})
// 实时流式收帧时 matchCount 会变，夹取 matchIndex 防越界（避免 5/3 这种显示）
watch(matchCount, (n) => {
  if (n === 0) matchIndex.value = 0
  else if (matchIndex.value >= n) matchIndex.value = n - 1
})

/** 匹配导航：+1 下一项、-1 上一项，循环；并滚动到目标帧 */
function goToMatch(delta: 1 | -1) {
  const n = matchCount.value
  if (n === 0) return
  matchIndex.value = (matchIndex.value + delta + n) % n
  const inst = scroller.value as unknown as { scrollToItem?: (index: number) => void } | null
  inst?.scrollToItem?.(matchIndex.value)
}

/** 清除时间筛选 */
function clearTimeFilter() {
  timeInputStart.value = ''
  timeInputEnd.value = ''
}

// 多选状态：右键进入，左键切选，底部操作栏批量复制 / 导出 / 删除
const multiSelect = ref(false)
const selected = reactive(new Set<number>())
const selectedCount = computed(() => selected.size)

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
      <NButtonGroup size="tiny">
        <NButton :type="searchMode === 'text' ? 'primary' : 'default'" @click="searchMode = 'text'">文本</NButton>
        <NButton :type="searchMode === 'hex' ? 'primary' : 'default'" @click="searchMode = 'hex'">HEX</NButton>
      </NButtonGroup>
      <NInput
        v-model:value="keyword"
        size="tiny"
        :placeholder="searchMode === 'hex' ? '搜索 HEX 字节' : '搜索关键字'"
        clearable
        style="width: 180px"
        @keydown.enter.exact="goToMatch(1)"
        @keydown.enter.shift="goToMatch(-1)"
      />
      <span v-if="hexError" class="hex-err">{{ hexError }}</span>
      <!-- 匹配导航 -->
      <span v-if="matchCount > 0" class="match-nav">
        <NButton size="tiny" quaternary :disabled="matchCount < 2" title="上一项 (Shift+Enter)" @click="goToMatch(-1)">↑</NButton>
        <span class="match-pos">{{ matchIndex + 1 }}/{{ matchCount }}</span>
        <NButton size="tiny" quaternary :disabled="matchCount < 2" title="下一项 (Enter)" @click="goToMatch(1)">↓</NButton>
      </span>
      <NTag size="small" :bordered="false">{{ filtered.length }} 帧</NTag>
      <div class="spacer" />
      <NButton
        size="tiny"
        :type="showTimeFilter || timeStart !== null || timeEnd !== null ? 'primary' : 'default'"
        title="时间筛选"
        @click="showTimeFilter = !showTimeFilter"
        >⏱</NButton
      >
      <NButton size="tiny" :type="messagesStore.paused ? 'warning' : 'default'" @click="messagesStore.togglePause()">
        {{ messagesStore.paused ? '已暂停' : '暂停' }}
      </NButton>
      <NButton size="tiny" @click="messagesStore.clear()">清空</NButton>
    </div>

    <!-- 时间筛选行 -->
    <div v-if="showTimeFilter" class="toolbar time-row">
      <span class="time-label">时间范围</span>
      <NInput
        v-model:value="timeInputStart"
        size="tiny"
        placeholder="HH:MM:SS"
        clearable
        :status="timeStartInvalid ? 'error' : undefined"
        style="width: 110px"
      />
      <span class="time-sep">–</span>
      <NInput
        v-model:value="timeInputEnd"
        size="tiny"
        placeholder="HH:MM:SS"
        clearable
        :status="timeEndInvalid ? 'error' : undefined"
        style="width: 110px"
      />
      <NButton size="tiny" quaternary @click="clearTimeFilter">清除</NButton>
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
              :keyword="keyword"
              :search-mode="searchMode"
              :match-ranges="matchRanges.get(item.id) ?? []"
              :active-match="matchIndex === index && matchCount > 0"
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
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
}
.time-row {
  border-top: 1px solid var(--glass-border);
  border-bottom: none;
  padding-top: 4px;
  padding-bottom: 4px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
}
.time-label {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
.time-sep {
  font-size: 11px;
  color: var(--text-dim);
}
.hex-err {
  font-size: 11px;
  color: var(--err);
  white-space: nowrap;
}
.match-nav {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.match-pos {
  font-size: 11px;
  font-family: var(--mono-font);
  color: var(--text-dim);
  min-width: 48px;
  text-align: center;
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
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border-top: 1px solid var(--glass-border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.12);
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
