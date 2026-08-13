<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DockviewPanelApi } from 'dockview-vue'

/**
 * 会话内视图 tab（消息/波形/终端）：dockview 自定义 tab 组件。
 * dockview 把 dv-active-tab 只加在 .dv-tab 祖先上，组件根拿不到该 class，
 * 活动态经 api.onDidActiveChange 订阅驱动（与 TerminalPane/WaveformChart 同款模式）。
 * 面板 id 区分视图类型 → 专属图标 + 主题色（消息蓝 / 波形青绿 / 终端青）。
 */
const props = defineProps<{ params: { api: DockviewPanelApi } }>()
const api = props.params.api

const { t } = useI18n()

const isActive = ref(api.isActive)
const apiSub = api.onDidActiveChange((e) => {
  isActive.value = e.isActive
})
onBeforeUnmount(() => apiSub.dispose())

/** 视图类型 → 主题色（CSS 变量，明暗主题自动跟随） */
const VIEW_META: Record<string, { color: string }> = {
  messages: { color: 'var(--accent)' },
  waveform: { color: 'var(--accent-teal)' },
  terminal: { color: 'var(--accent-cyan)' },
}
const meta = computed(() => VIEW_META[api.id] ?? VIEW_META.messages)
const title = computed(() => api.title ?? '')

function onClose() {
  // pointerdown 的 preventDefault 已阻止按钮区域触发 tab 拖拽；click 关闭面板
  api.close()
}
</script>

<template>
  <div class="view-tab" :class="{ active: isActive }" :style="{ '--c': meta.color }" :title="title">
    <svg
      v-if="api.id === 'messages'"
      class="tab-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H8.2L4.8 13.4v-2.4H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    </svg>
    <svg
      v-else-if="api.id === 'waveform'"
      class="tab-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2 2.5v11h11.5" />
      <path d="M3.5 10.2l2.8-3.2 2.2 2 3.5-4.2" />
    </svg>
    <svg
      v-else
      class="tab-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M1.5 3.5h13a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />
      <path d="M4.6 6.3l2 1.7-2 1.7" />
      <path d="M8.6 10.2h3" />
    </svg>
    <span class="view-tab-name">{{ title }}</span>
    <button
      class="view-tab-close"
      :title="t('app.closeView')"
      @pointerdown.prevent
      @click.stop="onClose"
    >×</button>
  </div>
</template>

<style scoped>
.view-tab {
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
.view-tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
/* 活动 tab：视图主题色浅底 + 图标/文字同色 + 同色下划线
   （覆盖 dockview.css 里全局 accent 下划线，见 .view-dock 中和规则） */
.view-tab.active {
  background: color-mix(in srgb, var(--c) 12%, transparent);
  color: var(--c);
  box-shadow: inset 0 -2px 0 var(--c);
}
.tab-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  opacity: 0.85;
}
.view-tab.active .tab-icon {
  opacity: 1;
}
.view-tab-name {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.view-tab-close {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  margin-left: 2px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.view-tab-close:hover {
  color: var(--err);
  background: rgba(255, 0, 0, 0.08);
}
</style>
