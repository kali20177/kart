<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DockviewPanelApi } from 'dockview-vue'
import { useSessions } from '@/composables/useSession'
import type { Session } from '@/session'

/**
 * 根级 dockview 的会话 tab：标题跟随端口、连接状态点、末会话不可关闭。
 * dockview 的 tab 内容组件与面板内容组件共用同一渲染器，props.params 结构一致：
 * params.params = addPanel 时的用户 params（即 Session 对象，响应式代理）；
 * params.api = 面板 api（id/close/setTitle）。
 * 点击激活与拖拽由 dockview 挂到根元素上的监听处理，本组件只渲染内容。
 */
const props = defineProps<{ params: { params: Session; api: DockviewPanelApi } }>()

const { t } = useI18n()
const sessions = useSessions()
const session = props.params.params

/** 未连接端口时的默认标题：按会话列表序号（与旧 tab 条「会话{n}」一致） */
const fallbackTitle = computed(() => {
  const i = sessions.value.findIndex((s) => s.id === session.id)
  return t('session.tabLabel', { n: Math.max(i, 0) + 1 })
})
const title = computed(() => session.serial.selectedPort ?? fallbackTitle.value)
/** 末会话保护：仅剩 1 个会话时不渲染关闭按钮（替代旧 tab 条的 disabled ×） */
const closable = computed(() => sessions.value.length > 1)

function onClose() {
  // pointerdown 的 preventDefault 已阻止按钮区域触发 tab 拖拽；click 关闭面板
  props.params.api.close()
}
</script>

<template>
  <div class="session-tab" :title="session.serial.selectedPort ?? undefined">
    <span class="session-tab-name">{{ title }}</span>
    <span
      class="session-tab-dot"
      :class="{ on: session.serial.connected, reconnecting: session.serial.reconnecting }"
    />
    <button
      v-if="closable"
      class="session-tab-close"
      :title="t('session.close')"
      @pointerdown.prevent
      @click.stop="onClose"
    >×</button>
  </div>
</template>

<style scoped>
/* 旧会话 tab 条样式迁移：dockview 为根元素附加 .dv-tab 类，活动态经 :global 命中 */
.session-tab {
  position: relative;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.session-tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
.session-tab:global(.dv-active-tab) {
  background: var(--bg-elevated);
  color: var(--accent);
}
.session-tab-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-tab-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.5;
  flex-shrink: 0;
}
.session-tab-dot.on {
  background: #4caf50;
  opacity: 1;
}
.session-tab-dot.reconnecting {
  background: #ff9800;
  opacity: 1;
}
.session-tab-close {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.session-tab-close:hover {
  color: var(--err);
  background: rgba(255, 0, 0, 0.08);
}
</style>
