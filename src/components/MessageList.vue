<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useClipboard, useDebounceFn } from '@vueuse/core'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import { NButton, NInput, NButtonGroup, NTag, NDropdown, NModal, useDialog, useMessage } from 'naive-ui'
import MessageBubble from './MessageBubble.vue'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import { useMessageSearch } from '@/composables/useMessageSearch'
import { parseTimeInput } from '@/utils/search'
import type { DataMode, Direction, Message } from '@/types'
import { formatMessageLine, formatTimestamp, computeDeltas } from '@/utils/message-format'
import ExportDialog from './ExportDialog.vue'

const props = defineProps<{ viewMode: DataMode }>()
const emit = defineEmits<{
  (e: 'resend', bytes: Uint8Array): void
}>()

const messagesStore = useMessagesStore()
const settingsStore = useSettingsStore()
const dialog = useDialog()
const toast = useMessage()
const { copy } = useClipboard()
const { t } = useI18n()

const dirFilter = ref<'all' | Direction>('all')
const keyword = ref('')
// 搜索输入防抖：NInput 即时绑定 keyword（输入回显），debouncedKeyword 喂给
// 过滤 / 命中区间 / 导航重置 / 气泡高亮门控，停顿 150ms 后统一重算，避免
// 大量消息时每次按键全量扫描。
const debouncedKeyword = ref('')
const setKeyword = useDebounceFn((v: string) => {
  debouncedKeyword.value = v
}, 150)
function onKeywordInput(v: string) {
  keyword.value = v
  setKeyword(v)
}
const timeInputStart = ref('')
const timeInputEnd = ref('')
const showTimeFilter = ref(false)
const hasNote = ref(false)
const matchIndex = ref(0)
/** 搜索类型跟随当前视图模式 —— ASCII 视图搜索文本，HEX 视图搜索原始字节 */
const searchMode = computed(() => props.viewMode === 'ascii' ? 'text' : 'hex')

/** HH:MM:SS[.mmm] / HH:MM → 当日毫秒数；非法返回 null */
const timeStart = computed(() => parseTimeInput(timeInputStart.value))
const timeEnd = computed(() => parseTimeInput(timeInputEnd.value))
/** 输入非空但解析失败 → 红框提示（不静默吞） */
const timeStartInvalid = computed(() => timeInputStart.value.trim() !== '' && timeStart.value === null)
const timeEndInvalid = computed(() => timeInputEnd.value.trim() !== '' && timeEnd.value === null)

const encoding = computed(() => settingsStore.settings.encoding)

/** 每帧的 Δt + elapsed（基于全量物理时间线，不受过滤影响） */
const deltaMap = computed(() => computeDeltas(messagesStore.messages))

const { filtered, matchRanges, matchCount, hexError } = useMessageSearch({
  messages: computed(() => messagesStore.messages),
  keyword: debouncedKeyword,
  searchMode,
  encoding,
  dirFilter,
  timeStart,
  timeEnd,
  hasNote
})

// 任何筛选条件变化 → 导航从头开始（命中集合已变）
watch([debouncedKeyword, searchMode, dirFilter, timeStart, timeEnd, hasNote], () => {
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

/** 搜索框回车：合并两个 keydown 处理器为单个函数，避免 Vue 3.4+ 将多个监听打包为数组 */
function onSearchKeydown(e: KeyboardEvent) {
  if (e.shiftKey) goToMatch(-1)
  else goToMatch(1)
}

// 多选状态：右键进入，左键切选，底部操作栏批量复制 / 导出 / 删除
const multiSelect = ref(false)
const selected = reactive(new Set<number>())
const selectedCount = computed(() => selected.size)

const scroller = ref<InstanceType<typeof DynamicScroller> | null>(null)
const follow = ref(true)
const showExportDialog = ref(false)
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

// —— 右键上下文菜单 ——
const showContextMenu = ref(false)
const contextX = ref(0)
const contextY = ref(0)
const contextMessage = ref<Message | null>(null)

// 分隔线插入对话框
const showDividerDialog = ref(false)
const dividerText = ref('')
const dividerTargetId = ref(0)

// 标注编辑对话框
const showNoteDialog = ref(false)
const noteText = ref('')
const noteTargetId = ref(0)

function onBubbleContext(item: Message, ev: MouseEvent) {
  ev.preventDefault()
  contextMessage.value = item
  contextX.value = ev.clientX
  contextY.value = ev.clientY
  showContextMenu.value = true
}

function onContextMenuSelect(key: string) {
  showContextMenu.value = false
  const target = contextMessage.value
  if (!target) return

  if (key === 'multi-select') {
    multiSelect.value = true
    selected.add(target.id)
  } else if (key === 'insert-divider') {
    dividerTargetId.value = target.id
    dividerText.value = ''
    showDividerDialog.value = true
  } else if (key === 'add-note') {
    noteTargetId.value = target.id
    noteText.value = target.note ?? ''
    showNoteDialog.value = true
  } else if (key === 'remove-note') {
    messagesStore.setMessageNote(target.id, null)
  }
}

function onInsertDivider() {
  messagesStore.insertDividerBefore(dividerTargetId.value, dividerText.value)
  showDividerDialog.value = false
}

function onSaveNote() {
  messagesStore.setMessageNote(noteTargetId.value, noteText.value || null)
  showNoteDialog.value = false
}

const contextMenuOptions = computed(() => {
  const target = contextMessage.value
  const opts: any[] = [
    { label: t('msgList.insertDividerBefore'), key: 'insert-divider' },
  ]
  if (target && target.kind !== 'divider' && target.kind !== 'file') {
    opts.push({ label: t('msgList.addNote'), key: 'add-note' })
    if (target.note) {
      opts.push({ label: t('msgList.removeNote'), key: 'remove-note' })
    }
  }
  opts.push({ type: 'divider' as const, key: 'd1' })
  opts.push({ label: t('msgList.multiSelectMode'), key: 'multi-select' })
  return opts
})

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
  copy(lines)
    .then(() => toast.success(t('msgList.copiedN', { n: selectedCount.value })))
    .catch(() => toast.error(t('msgList.copyFailed')))
}

function exportSelected() {
  if (selectedCount.value === 0) return
  showExportDialog.value = true
}

function deleteSelected() {
  const n = selectedCount.value
  if (n === 0) return
  dialog.warning({
    title: t('msgList.deleteDialogTitle'),
    content: t('msgList.deleteDialogContent', { n }),
    positiveText: t('msgList.deleteDialogOk'),
    negativeText: t('msgList.deleteDialogCancel'),
    onPositiveClick: () => {
      messagesStore.removeByIds([...selected])
      selected.clear()
      multiSelect.value = false
    }
  })
}

// 暂停恢复时提醒缺失数据时间范围
watch(
  () => messagesStore.paused,
  (p, wasPaused) => {
    if (wasPaused && !p && settingsStore.settings.showPauseNotification) {
      const start = messagesStore.pauseStartTime
      const dur = Math.max(1, Math.round((Date.now() - start) / 1000))
      toast.warning(
        t('msgList.pauseNotice', {
          start: formatTimestamp(start, 'short'),
          end: formatTimestamp(Date.now(), 'short'),
          dur
        }),
        { duration: 5000 }
      )
    }
  }
)
</script>

<template>
  <div class="list-wrap">
    <div class="toolbar">
      <NButtonGroup size="tiny">
        <NButton :type="dirFilter === 'all' ? 'primary' : 'default'" @click="dirFilter = 'all'">{{ t('msgList.all') }}</NButton>
        <NButton :type="dirFilter === 'rx' ? 'primary' : 'default'" @click="dirFilter = 'rx'">RX</NButton>
        <NButton :type="dirFilter === 'tx' ? 'primary' : 'default'" @click="dirFilter = 'tx'">TX</NButton>
      </NButtonGroup>
      <NInput
        :value="keyword"
        size="tiny"
        :placeholder="searchMode === 'hex' ? t('msgList.searchHex') : t('msgList.searchKeyword')"
        clearable
        style="width: 180px"
        @update:value="onKeywordInput"
        @keydown.enter="onSearchKeydown"
      />
      <span v-if="hexError" class="hex-err">{{ hexError }}</span>
      <NButton
        size="tiny"
        :type="showTimeFilter || timeStart !== null || timeEnd !== null ? 'primary' : 'default'"
        :title="t('msgList.timeFilter')"
        @click="showTimeFilter = !showTimeFilter"
        >⏱</NButton
      >
      <NButton
        size="tiny"
        :type="hasNote ? 'primary' : 'default'"
        :title="t('msgList.filterNote')"
        @click="hasNote = !hasNote"
        >📌</NButton
      >
      <!-- 匹配导航 -->
      <span v-if="matchCount > 0" class="match-nav">
        <NButton size="tiny" quaternary :disabled="matchCount < 2" :title="t('msgList.prevMatch')" @click="goToMatch(-1)">↑</NButton>
        <span class="match-pos">{{ matchIndex + 1 }}/{{ matchCount }}</span>
        <NButton size="tiny" quaternary :disabled="matchCount < 2" :title="t('msgList.nextMatch')" @click="goToMatch(1)">↓</NButton>
      </span>
      <NTag size="small" :bordered="false">{{ filtered.length }} {{ t('msgList.frames') }}</NTag>
      <div class="spacer" />
      <NButton size="tiny" :type="messagesStore.paused ? 'warning' : 'default'" @click="messagesStore.togglePause()">
        {{ messagesStore.paused ? t('msgList.paused') : t('msgList.pause') }}
      </NButton>
      <NButton size="tiny" @click="messagesStore.clear()">{{ t('msgList.clearAll') }}</NButton>
    </div>

    <!-- 时间筛选行 -->
    <div v-if="showTimeFilter" class="toolbar time-row">
      <span class="time-label">{{ t('msgList.timeRange') }}</span>
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
      <NButton size="tiny" quaternary @click="clearTimeFilter">{{ t('msgList.clear') }}</NButton>
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
              :keyword="debouncedKeyword"
              :search-mode="searchMode"
              :match-ranges="matchRanges.get(item.id) ?? []"
              :active-match="matchIndex === index && matchCount > 0"
              :delta-ms="deltaMap.get(item.id)?.deltaMs"
              :elapsed-ms="deltaMap.get(item.id)?.elapsedMs"
              @resend="emit('resend', $event)"
              @select="onBubbleSelect(item)"
              @contextmenu="(e: MouseEvent) => onBubbleContext(item, e)"
            />
          </DynamicScrollerItem>
        </template>
      </DynamicScroller>

      <Transition name="fade">
        <NButton v-if="!multiSelect && !follow" class="jump-btn" size="small" type="primary" @click="jumpLatest">
          {{ t('msgList.backToLatest') }}
        </NButton>
      </Transition>

      <!-- 多选操作栏 -->
      <div v-if="multiSelect" class="action-bar">
        <NTag size="small" :bordered="false" type="info">{{ t('msgList.selected', { n: selectedCount }) }}</NTag>
        <NButton size="small" :disabled="selectedCount === 0" @click="copySelected">{{ t('msgList.copy') }}</NButton>
        <NButton size="small" :disabled="selectedCount === 0" @click="exportSelected">{{ t('export.exportBtn') }}</NButton>
        <NButton size="small" type="error" :disabled="selectedCount === 0" @click="deleteSelected">{{ t('msgList.delete') }}</NButton>
        <NButton size="small" @click="selectAllVisible">{{ t('msgList.selectAll') }}</NButton>
        <div class="spacer" />
        <NButton size="small" quaternary @click="exitMultiSelect">{{ t('msgList.cancel') }}</NButton>
      </div>
    </div>

    <ExportDialog
      v-if="showExportDialog"
      :messages="messagesStore.messages"
      :selected-messages="selectedMessages()"
      default-scope="selected"
      @close="showExportDialog = false"
    />

    <!-- 右键上下文菜单 -->
    <NDropdown
      trigger="manual"
      :show="showContextMenu"
      :x="contextX"
      :y="contextY"
      :options="contextMenuOptions"
      @clickoutside="showContextMenu = false"
      @select="onContextMenuSelect"
    />

    <!-- 分隔线插入对话框 -->
    <NModal v-model:show="showDividerDialog" preset="card" :title="t('msgList.insertDividerTitle')" style="width: 400px" :mask-closable="false">
      <div class="marker-dialog-body">
        <div class="marker-dialog-field">
          <span class="marker-dialog-label">{{ t('msgList.dividerLabel') }}</span>
          <NInput
            v-model:value="dividerText"
            type="textarea"
            :rows="2"
            :placeholder="t('msgList.dividerLabelPlaceholder')"
          />
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <NButton @click="showDividerDialog = false">{{ t('msgList.cancel') }}</NButton>
          <NButton type="primary" @click="onInsertDivider">{{ t('msgList.insert') }}</NButton>
        </div>
      </template>
    </NModal>

    <!-- 标注编辑对话框 -->
    <NModal v-model:show="showNoteDialog" preset="card" :title="t('msgList.editNoteTitle')" style="width: 400px" :mask-closable="false">
      <div class="marker-dialog-body">
        <div class="marker-dialog-field">
          <span class="marker-dialog-label">{{ t('msgList.noteText') }}</span>
          <NInput
            v-model:value="noteText"
            type="textarea"
            :rows="3"
            :placeholder="t('msgList.notePlaceholder')"
          />
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <NButton @click="showNoteDialog = false">{{ t('msgList.cancel') }}</NButton>
          <NButton type="primary" @click="onSaveNote">{{ t('msgList.saveNote') }}</NButton>
        </div>
      </template>
    </NModal>
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

/* 标记对话框 */
.marker-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.marker-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.marker-dialog-label {
  font-size: 13px;
  color: var(--text-dim);
}
</style>
