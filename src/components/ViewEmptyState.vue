<script setup lang="ts">
/**
 * 视图空态占位——消息/波形/终端三视图共用（布局与配色单源）。
 * kind 决定强调色语义：idle 中性（未激活）/ waiting 主题强调色（正在听）/
 * paused 警告 / no-fields 警告（有数据但不合格式，需要用户调整配置）/
 * filtered 弱化。glyph 图形各视图不同，经默认插槽传入；
 * **状态判定留在各视图**——三者语义不同（消息看筛选、波形看可解析点、终端只看连接）。
 */
defineProps<{
  kind: 'idle' | 'waiting' | 'paused' | 'no-fields' | 'filtered'
  title: string
  hint: string
  /** 次级提示行（如 idle 态的排障指引）；缺省不渲染 */
  step?: string
}>()
</script>

<template>
  <div class="empty-state" :data-kind="kind">
    <div class="empty-glyph" aria-hidden="true">
      <slot />
    </div>
    <div class="empty-title">{{ title }}</div>
    <div class="empty-hint">{{ hint }}</div>
    <div v-if="step" class="empty-step">{{ step }}</div>
  </div>
</template>

<style scoped>
/* 自 MessageList 迁出：屏幕中央占位，各状态共用布局，icon 颜色与文案随 kind 变化。
   pointer-events: none——组件纯信息展示；调用方常把它做成面板根级覆盖层，
   须让底下的工具栏/输入条照常可点击 */
.empty-state {
  pointer-events: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 32px;
  gap: 12px;
  text-align: center;
  color: var(--text-dim);
  user-select: none;
}
.empty-glyph {
  width: 92px;
  height: 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pill-radius);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  /* muted 颜色与边框呼应「未激活」语义 */
  color: var(--text-dim);
  margin-bottom: 4px;
  position: relative;
}
.empty-glyph :deep(svg) {
  width: 52px;
  height: 52px;
  opacity: 0.85;
}
.empty-state[data-kind='waiting'] .empty-glyph {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}
.empty-state[data-kind='paused'] .empty-glyph,
.empty-state[data-kind='no-fields'] .empty-glyph {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 35%, var(--border));
}
.empty-state[data-kind='filtered'] .empty-glyph {
  color: var(--text-dim);
  opacity: 0.7;
}
/* waiting 状态：图标右侧的状态灯呼吸脉动，提示「正在听」（灯元素由各视图 glyph 自带） */
.empty-state[data-kind='waiting'] :deep(.empty-led.waiting) {
  animation: empty-pulse 1.6s ease-in-out infinite;
}
@keyframes empty-pulse {
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 1;    }
}
@media (prefers-reduced-motion: reduce) {
  .empty-state[data-kind='waiting'] :deep(.empty-led.waiting) { animation: none; }
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.2px;
}
.empty-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
  max-width: 340px;
}
.empty-step {
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.7;
}
</style>
