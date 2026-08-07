<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RecycleScroller } from 'vue-virtual-scroller'
import { NButton, NButtonGroup, NSelect, useMessage } from 'naive-ui'
import { useClipboard } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import TerminalInput from './TerminalInput.vue'
import { useSession } from '@/composables/useSession'
import { lineToSegments } from '@/terminal/screen-buffer'
import type { TermLine, TermSegment } from '@/terminal/screen-buffer'
import type { LineEnding } from '@/types'

/** 终端视图：视口（虚拟滚动回滚区 + 块状光标）+ 工具栏 + 终端输入 */
const props = defineProps<{ active: boolean }>()

const { terminal, settings, pause } = useSession()
const { t } = useI18n()
const toast = useMessage()
const { copy } = useClipboard()

// 会话内视图态（默认取全局设置，快速切换不落盘——SettingsModal 阶段二统一持久化）
const mode = ref<'line' | 'char'>(settings.terminal.transmitMode)
const echo = ref(settings.terminal.echo)
const lineEnding = ref<LineEnding>(settings.terminal.lineEnding)
const backspace = settings.terminal.backspace

const endingOptions = [
  { label: '无', value: 'none' },
  { label: '\\r', value: 'cr' },
  { label: '\\n', value: 'lf' },
  { label: '\\r\\n', value: 'crlf' }
]

const fontSize = computed(() => settings.fontSize * settings.terminal.fontScale)
const lineHeight = computed(() => Math.round(fontSize.value * 1.4))
// 行高经 CSS 变量透传给光标块：inline span 的背景默认只盖字体 em-box（≈1em），
// 不撑满行高，导致「块」光标退化成一条偏上的横线——必须显式铺满整行。
const lineStyle = computed(() => ({
  height: `${lineHeight.value}px`,
  lineHeight: `${lineHeight.value}px`,
  fontSize: `${fontSize.value}px`,
  '--term-line-height': `${lineHeight.value}px`,
}))

const scrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<InstanceType<typeof TerminalInput> | null>(null)
let scrollEl: HTMLElement | null = null
let ro: ResizeObserver | null = null

const follow = ref(true)

/** 当前光标所在行对象（item 命中时渲染块状光标；仅跟随底部时可见） */
const cursorLine = computed(() => terminal.lines[terminal.cursor.line] ?? null)

const droppedBarDismissed = ref(false)
const showDroppedBar = computed(() => terminal.droppedLines > 0 && !droppedBarDismissed.value)
/** 调试：原始 RX 字节 hex 视图 */
const showRaw = ref(false)

function segments(line: TermLine, cursorCol: number | null): TermSegment[] {
  return lineToSegments(line, cursorCol)
}

function segStyle(seg: TermSegment): Record<string, string> {
  const s: Record<string, string> = {}
  if (seg.fg) s.color = seg.fg
  if (seg.bg) s.background = seg.bg
  if (seg.bold) s.fontWeight = '700'
  return s
}

function measureCharWidth(): number {
  const el = viewportRef.value
  if (!el) return 0
  const probe = document.createElement('span')
  probe.textContent = 'M'.repeat(20)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none'
  el.appendChild(probe)
  const w = probe.getBoundingClientRect().width / 20
  probe.remove()
  return w
}

function updateSize() {
  const el = viewportRef.value
  if (!el || el.clientWidth === 0) return
  const cw = measureCharWidth()
  if (cw <= 0) return
  const cols = Math.max(1, Math.floor(el.clientWidth / cw))
  const rows = Math.max(1, Math.floor(el.clientHeight / lineHeight.value))
  terminal.setSize(cols, rows)
}

function onScroll() {
  if (!scrollEl) return
  const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
  follow.value = dist < 24
}

function scrollToBottom() {
  ;(scrollerRef.value as unknown as { scrollToItem?: (i: number) => void } | null)?.scrollToItem?.(
    terminal.lines.length - 1
  )
}

function jumpLatest() {
  follow.value = true
  nextTick(scrollToBottom)
}

async function onCopy() {
  const text = terminal.scrollbackText()
  if (!text) {
    toast.warning(t('terminal.empty'))
    return
  }
  await copy(text)
  toast.success(t('terminal.copied'))
}

function onClear() {
  terminal.clear()
  droppedBarDismissed.value = false
  follow.value = true
}

onMounted(() => {
  ro = new ResizeObserver(updateSize)
  if (viewportRef.value) ro.observe(viewportRef.value)
  scrollEl = (scrollerRef.value as unknown as { $el: HTMLElement } | null)?.$el ?? null
  scrollEl?.addEventListener('scroll', onScroll, { passive: true })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  scrollEl?.removeEventListener('scroll', onScroll)
  scrollEl = null
})

// 新数据到达：仅"跟随最新"时滚到底（RecycleScroller 不自动跟随）
watch(
  () => terminal.lines.length,
  () => {
    if (follow.value) nextTick(scrollToBottom)
  }
)

// 视图变为可见时刷新尺寸并聚焦输入（v-show 常驻挂载，切换 tab 时触发）
watch(
  () => props.active,
  (active) => {
    if (active) {
      nextTick(() => {
        updateSize()
        inputRef.value?.focus()
      })
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="term-pane">
    <div class="toolbar">
      <NButtonGroup size="tiny">
        <NButton :type="mode === 'char' ? 'primary' : 'default'" @click="mode = 'char'">
          {{ t('terminal.charMode') }}
        </NButton>
        <NButton :type="mode === 'line' ? 'primary' : 'default'" @click="mode = 'line'">
          {{ t('terminal.lineMode') }}
        </NButton>
      </NButtonGroup>
      <NButton
        size="tiny"
        :type="echo ? 'primary' : 'default'"
        :title="t('terminal.echoTitle')"
        @click="echo = !echo"
      >
        {{ t('terminal.echo') }}
      </NButton>
      <NSelect
        v-model:value="lineEnding"
        :options="endingOptions"
        size="tiny"
        style="width: 88px"
        :title="t('terminal.lineEnding')"
      />
      <div class="spacer" />
      <NButton size="tiny" :type="pause.paused ? 'warning' : 'default'" @click="pause.toggle()">
        {{ pause.paused ? t('terminal.paused') : t('terminal.pause') }}
      </NButton>
      <NButton size="tiny" @click="onClear">{{ t('terminal.clear') }}</NButton>
      <NButton size="tiny" @click="onCopy">{{ t('terminal.copy') }}</NButton>
      <NButton
        size="tiny"
        :type="showRaw ? 'primary' : 'default'"
        :title="t('terminal.rawDumpTitle')"
        @click="showRaw = !showRaw"
        >RX</NButton
      >
    </div>

    <div ref="viewportRef" class="viewport" @click="inputRef?.focus()">
      <div v-if="showDroppedBar" class="dropped-bar">
        <span>{{ t('terminal.droppedLines', { n: terminal.droppedLines }) }}</span>
        <button type="button" class="dropped-dismiss" :title="t('terminal.cancel')" @click="droppedBarDismissed = true">✕</button>
      </div>
      <RecycleScroller
        ref="scrollerRef"
        :items="terminal.lines"
        :item-size="lineHeight"
        key-field="key"
        class="scroller"
      >
        <template #default="{ item }">
          <div class="term-line" :style="lineStyle">
            <span
              v-for="(seg, i) in segments(item, item === cursorLine ? terminal.cursor.col : null)"
              :key="i"
              class="seg"
              :class="{ cursor: seg.cursor }"
              :style="segStyle(seg)"
              >{{ seg.text }}</span
            >
          </div>
        </template>
      </RecycleScroller>
      <div v-if="showRaw" class="raw-dump">{{ terminal.rawDump }}</div>
      <Transition name="fade">
        <NButton v-if="!follow" class="jump-btn" size="small" type="primary" @click="jumpLatest">
          {{ t('terminal.backToLatest') }}
        </NButton>
      </Transition>
    </div>

    <TerminalInput
      ref="inputRef"
      :mode="mode"
      :echo="echo"
      :line-ending="lineEnding"
      :backspace="backspace"
    />
  </div>
</template>

<style scoped>
.term-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  font-family: var(--mono-font);
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
.spacer {
  flex: 1;
}
.viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--bg-panel);
  overflow: hidden;
}
.scroller {
  height: 100%;
  padding: 4px 0;
}
.term-line {
  overflow: hidden;
  white-space: pre;
}
.seg {
  font-family: inherit;
  font-size: inherit;
}
.seg.cursor {
  /* 块状光标：撑满整行高度（inline span 背景只盖 em-box，需显式铺满行高） */
  display: inline-block;
  height: var(--term-line-height);
  line-height: var(--term-line-height);
  background: var(--accent);
  color: var(--bg-elevated);
}
.dropped-bar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 90%;
  padding: 4px 6px 4px 12px;
  border-radius: var(--radius);
  background: var(--glass-bg);
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: 11px;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
}
.dropped-dismiss {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px;
  border-radius: var(--radius-sm);
}
.dropped-dismiss:hover {
  background: rgba(255, 255, 255, 0.14);
}
.jump-btn {
  position: absolute;
  right: 18px;
  bottom: 14px;
}
.raw-dump {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 3;
  max-height: 40%;
  overflow: auto;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--glass-bg);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
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
