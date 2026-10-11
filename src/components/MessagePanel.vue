<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MessageList from '@/components/MessageList.vue'
import InputComposer from '@/components/InputComposer.vue'
import ViewEmptyState from '@/components/ViewEmptyState.vue'
import { useSession, useOpenFileTransfer } from '@/composables/useSession'

/**
 * 消息面板 = 消息列表 + 发送框。
 * 发送框属于消息面板：随面板一起显示/隐藏/移动——拖拽布局时它始终贴在消息面板
 * 底部，而非整个会话底部；切到波形/终端 tab 或关闭消息面板时发送框一并消失。
 *
 * 面板级空态覆盖层：无消息时的 未连接/等待/已暂停 提示锚定在整个面板（含发送框）
 * ——与波形/终端的空态同一参照系，切换视图时 glyph 不上下跳动。
 * 「筛选无命中」是列表内部语义（依赖列表的筛选状态），仍由 MessageList 自行渲染。
 */
const session = useSession()
const openFileTransfer = useOpenFileTransfer()
const { t } = useI18n()

const emptyState = computed<'idle' | 'waiting' | 'paused' | null>(() => {
  if (session.messages.messages.length > 0) return null
  if (session.pause.paused) return 'paused'
  if (session.serial.connected) return 'waiting'
  return 'idle'
})
</script>

<template>
  <div class="message-panel">
    <div class="list-area">
      <MessageList />
    </div>
    <InputComposer
      v-model:text="session.composerText"
      v-model:mode="session.viewMode"
      @open-file-transfer="openFileTransfer"
    />
    <ViewEmptyState
      v-if="emptyState"
      class="panel-empty"
      :kind="emptyState"
      :title="t(`viewEmpty.${emptyState}Title`)"
      :hint="t(`viewEmpty.${emptyState}Hint`)"
      :step="emptyState === 'idle' ? t('viewEmpty.idleStep') : undefined"
    >
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <rect x="14" y="20" width="36" height="24" rx="3" />
        <path d="M14 28 L14 36 L50 36 L50 28" />
        <circle cx="46" cy="24" r="0.9" fill="currentColor" />
        <path v-if="emptyState === 'idle'" class="empty-led" d="M24 44 L24 44.01" />
        <path v-else-if="emptyState === 'waiting'" class="empty-led waiting" d="M24 44 L24 44.01" />
        <path v-else d="M22 42 L26 42" />
      </svg>
    </ViewEmptyState>
  </div>
</template>

<style scoped>
.message-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  /* dockview 下父容器（.dv-vue-part）是 block 非 flex，flex:1 不生效，须显式定高 */
  height: 100%;
  min-height: 0;
}
.list-area {
  flex: 1;
  min-height: 0;
  display: flex;
}
.list-area :deep(.list-wrap) {
  width: 100%;
}
/* 面板级空态覆盖层：透明 + pointer-events:none（组件自带），工具栏/发送框照常可用 */
.panel-empty {
  position: absolute;
  inset: 0;
}
</style>
