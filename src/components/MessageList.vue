<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import { NButton, NInput, NButtonGroup, NTag } from 'naive-ui'
import MessageBubble from './MessageBubble.vue'
import { useMessagesStore } from '@/stores/messages'
import { useSettingsStore } from '@/stores/settings'
import type { DataMode, Direction } from '@/types'
import { decodeBytes } from '@/utils/encoding'

const props = defineProps<{ viewMode: DataMode }>()
const emit = defineEmits<{ (e: 'resend', bytes: Uint8Array): void }>()

const messagesStore = useMessagesStore()
const settingsStore = useSettingsStore()

const dirFilter = ref<'all' | Direction>('all')
const keyword = ref('')

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

watch(
  () => messagesStore.messages.length,
  () => {
    if (follow.value) nextTick(scrollToBottom)
  }
)

function jumpLatest() {
  follow.value = true
  nextTick(scrollToBottom)
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
              @resend="emit('resend', $event)"
            />
          </DynamicScrollerItem>
        </template>
      </DynamicScroller>

      <Transition name="fade">
        <NButton v-if="!follow" class="jump-btn" size="small" type="primary" @click="jumpLatest">
          ↓ 回到最新
        </NButton>
      </Transition>
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
.jump-btn {
  position: absolute;
  right: 18px;
  bottom: 14px;
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
