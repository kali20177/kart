<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { DockviewPanelApi } from 'dockview-vue'
import { useSessions } from '@/composables/useSession'
import { useConnbarCollapse } from '@/composables/useConnbarCollapse'
import type { Session } from '@/session'

/**
 * 根级 dockview 的会话 tab：标题跟随端口、连接状态点、末会话不可关闭。
 * dockview 的 tab 内容组件与面板内容组件共用同一渲染器，props.params 结构一致：
 * params.params = addPanel 时的用户 params（即 Session 对象，响应式代理）；
 * params.api = 面板 api（id/close/setTitle）。
 * 点击激活与拖拽由 dockview 挂到根元素上的监听处理，本组件只渲染内容。
 *
 * 参数栏收起时（useConnbarCollapse，与面板内 ConnectionBar 共享状态）tab 上追加
 * 连接切换（电源图标）与展开参数两个 mini 按钮——tab 单击本身仍是「激活会话」，
 * 按钮经 pointerdown.prevent + click.stop 阻断激活/拖拽；录制中名字前亮红点。
 */
const props = defineProps<{ params: { params: Session; api: DockviewPanelApi } }>()

const { t } = useI18n()
const message = useMessage()
const sessions = useSessions()
const session = props.params.params
const { collapsed } = useConnbarCollapse(session)

/** 未连接端口时的默认标题：按会话列表序号（与旧 tab 条「会话{n}」一致） */
const fallbackTitle = computed(() => {
  const i = sessions.value.findIndex((s) => s.id === session.id)
  return t('session.tabLabel', { n: Math.max(i, 0) + 1 })
})
const title = computed(() => session.serial.selectedPort ?? fallbackTitle.value)
/** 末会话保护：仅剩 1 个会话时不渲染关闭按钮（替代旧 tab 条的 disabled ×） */
const closable = computed(() => sessions.value.length > 1)

/** 收起态录制指示：录制中或停止中亮红点（完整 REC 按钮在展开态参数栏里） */
const recording = computed(
  () => session.recorder.isRecording || session.recorder.state.status === 'stopping',
)

function onClose() {
  // pointerdown 的 preventDefault 已阻止按钮区域触发 tab 拖拽；click 关闭面板
  props.params.api.close()
}

/** tab 上的连接/断开（与 ConnectionBar 连接按钮同语义；失败经全局 message 提示） */
async function toggleConnect() {
  try {
    if (session.serial.connected) await session.serial.userDisconnect()
    else await session.serial.connect()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('conn.connectFailed'))
  }
}
</script>

<template>
  <div class="session-tab" :title="session.serial.selectedPort ?? undefined">
    <span v-if="collapsed && recording" class="session-tab-rec" />
    <span class="session-tab-name">{{ title }}</span>
    <span
      class="session-tab-dot"
      :class="{ on: session.serial.connected, reconnecting: session.serial.reconnecting }"
    />
    <template v-if="collapsed">
      <button
        type="button"
        class="session-tab-conn"
        :class="{ on: session.serial.connected, reconnecting: session.serial.reconnecting }"
        :title="session.serial.connected ? t('conn.disconnect') : t('conn.connect')"
        @pointerdown.prevent
        @click.stop="toggleConnect"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round">
          <path d="M5 1v3.6" />
          <path d="M3 2.2a3.4 3.4 0 1 0 4 0" />
        </svg>
      </button>
      <button
        type="button"
        class="session-tab-expand"
        :title="t('conn.expandParams')"
        @pointerdown.prevent
        @click.stop="collapsed = false"
      >⌄</button>
    </template>
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
  border-radius: var(--pill-radius);
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
/* 收起态录制指示红点（名字前，与 REC 按钮圆点同款闪烁） */
.session-tab-rec {
  width: 6px;
  height: 6px;
  border-radius: var(--pill-radius);
  background: var(--err);
  flex-shrink: 0;
  animation: session-tab-rec-blink 1s steps(2, start) infinite;
}
@keyframes session-tab-rec-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  .session-tab-rec {
    animation-duration: 2.4s;
  }
}
/* 收起态 tab 上 mini 按钮：连接切换（电源图标）/ 展开参数（⌄）。
   颜色语义与状态点一致：绿=已连接（点击断开）、橙=重连中、灰=未连接（点击连接） */
.session-tab-conn,
.session-tab-expand {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition: color 0.15s, background-color 0.15s;
}
.session-tab-conn:hover,
.session-tab-expand:hover {
  color: var(--accent);
  background: var(--bg-elevated);
}
.session-tab-conn.on {
  color: #4caf50;
}
.session-tab-conn.reconnecting {
  color: #ff9800;
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
