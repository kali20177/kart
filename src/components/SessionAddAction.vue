<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { DockviewGroupPanel } from 'dockview-vue'
import { useNewSessionHandler } from '@/composables/useSession'

/**
 * 根级 dockview 会话 tab 条的「新建会话」按钮（浏览器式 +）。
 * 经 leftHeaderActionsComponent 渲染在每组 tab 条的最后一个会话 tab 右侧
 * （dockview DOM 顺序：tabs → left-actions → 留白），取代旧右上角悬浮按钮。
 * dockview 为每个 group 实例化一份本组件：多组并排对比时各组的 tab 条都有 +，
 * 点击经注入回调（App.vue 提供）新建会话并把面板加进所在组。
 * props.params 由 dockview 注入（{ api, containerApi, group, panels, ... }），
 * 组内面板增删/激活变化时自动刷新，group 引用始终有效。
 */
const props = defineProps<{ params: { group: DockviewGroupPanel } }>()

const { t } = useI18n()
const onNewSession = useNewSessionHandler()
</script>

<template>
  <button
    type="button"
    class="session-add"
    :title="t('session.new')"
    @click="onNewSession(props.params.group)"
  >＋</button>
</template>

<style scoped>
/* 与会话 tab 上的 mini 按钮同款视觉：透明底、hover 提亮；纵向居中由
   全局 .dv-left-actions-container 规则保证（styles/dockview.css） */
.session-add {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  width: 22px;
  height: 22px;
  /* 字面量「＋」用文本基线排列会偏上，flex 居中保证字形在方框正中 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0 3px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background-color 0.15s;
}
.session-add:hover {
  color: var(--accent);
  background: var(--bg-elevated);
}
</style>
