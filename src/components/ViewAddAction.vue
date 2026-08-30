<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NDropdown } from 'naive-ui'
import type { DockviewGroupPanel } from 'dockview-vue'
import { useViewAddMenu } from '@/composables/useViewAddMenu'

/**
 * 会话内视图 dock tab 条的「＋」按钮（添加/聚焦视图：消息/波形/终端/仪表盘）。
 * 经 leftHeaderActionsComponent 渲染在每组 tab 条最后一个视图 tab 右侧（浏览器式 +），
 * 取代旧右上角悬浮按钮；点击弹出与旧按钮相同的下拉菜单（✓ 已打开聚焦 / ＋ 新开）。
 * 菜单选项与选中回调由 SessionPane 注入（本组件由 dockview 渲染、无法走 emit 链）；
 * 选中时携带按钮所在 group——视图并排分栏时在哪个组的 tab 条点＋就在哪个组开视图。
 */
const props = defineProps<{ params: { group: DockviewGroupPanel } }>()

const { t } = useI18n()
const { options, select } = useViewAddMenu()

/** 无 icon 选项也带 10px 空前缀列（naive-ui 默认），归零让 ✓/＋ 槽贴面板左缘 */
const dropdownOverrides = {
  optionPrefixWidthSmall: '0px',
  optionPrefixWidthMedium: '0px',
  optionPrefixWidthLarge: '0px',
  optionPrefixWidthHuge: '0px',
}

function onSelect(key: string | number) {
  select(String(key), props.params.group)
}
</script>

<template>
  <!-- bottom-start：面板左缘对齐＋按钮左缘（默认 bottom 居中会让面板随宽度左漂） -->
  <NDropdown
    trigger="click"
    placement="bottom-start"
    :options="options"
    :theme-overrides="dropdownOverrides"
    @select="onSelect"
  >
    <button type="button" class="view-add" :title="t('app.addView')">＋</button>
  </NDropdown>
</template>

<style scoped>
/* 与会话 tab 条的＋按钮（session-add）同款视觉；纵向居中由全局
   .dv-left-actions-container 规则保证（styles/dockview.css） */
.view-add {
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
.view-add:hover {
  color: var(--accent);
  background: var(--bg-elevated);
}
</style>
