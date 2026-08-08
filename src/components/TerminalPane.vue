<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NButtonGroup, NSelect, useMessage } from 'naive-ui'
import { useClipboard } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { FitAddon } from '@xterm/addon-fit'
import TerminalInput from './TerminalInput.vue'
import { useSession } from '@/composables/useSession'

/**
 * 终端视图：xterm 视口（内置 cell 网格/SGR/回滚/alt-screen）+ 工具栏 + 输入条。
 * char 模式直接键入 xterm（onData 由 terminal store 下发）；line 模式渲染本地输入条。
 */
const props = defineProps<{ active: boolean }>()

const { terminal, serial, settings, pause } = useSession()
const { t } = useI18n()
const toast = useMessage()
const { copy } = useClipboard()

const endingOptions = [
  { label: '无', value: 'none' },
  { label: '\\r', value: 'cr' },
  { label: '\\n', value: 'lf' },
  { label: '\\r\\n', value: 'crlf' }
]

const viewportRef = ref<HTMLDivElement | null>(null)
const termHost = ref<HTMLDivElement | null>(null)
const inputRef = ref<InstanceType<typeof TerminalInput> | null>(null)
let fitAddon: FitAddon | null = null
let ro: ResizeObserver | null = null
let opened = false

const follow = ref(true)
const droppedBarDismissed = ref(false)
const showDroppedBar = computed(() => terminal.droppedLines > 0 && !droppedBarDismissed.value)
/** 调试：原始 RX 字节 hex 视图 */
const showRaw = ref(false)

/** 首次挂载：xterm.open + FitAddon + 跟随滚动监听 */
function ensureOpen() {
  if (opened || !termHost.value) return
  opened = true
  terminal.term.open(termHost.value)
  fitAddon = new FitAddon()
  terminal.term.loadAddon(fitAddon)
  fit()
  terminal.term.onScroll(() => {
    const b = terminal.term.buffer.active
    follow.value = b.viewportY >= b.baseY
  })
}

/** 自适应尺寸（隐藏容器宽高为 0 时跳过，切回可见后由 ResizeObserver 补 fit） */
function fit() {
  const host = termHost.value
  if (!host || host.clientWidth === 0) return
  fitAddon?.fit()
  // 设置里显式指定行列时覆盖 FitAddon
  const s = settings.terminal
  if (s.cols > 0 || s.rows > 0) {
    terminal.setSize(s.cols || terminal.term.cols, s.rows || terminal.term.rows)
  }
}

function scrollToBottom() {
  terminal.term.scrollToBottom()
  follow.value = true
}

function focusTerm() {
  if (terminal.mode === 'char' && opened) terminal.term.focus()
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
  ro = new ResizeObserver(() => {
    if (opened) fit()
  })
  if (viewportRef.value) ro.observe(viewportRef.value)
  if (props.active) nextTick(ensureOpen)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  // xterm 实例生命周期由 terminal store 的 onScopeDispose 统一 dispose（会话关闭时）
})

// 视图切到终端时挂载 + 自适应 + 聚焦
watch(
  () => props.active,
  (active) => {
    if (active) {
      nextTick(() => {
        ensureOpen()
        fit()
        if (terminal.mode === 'char') terminal.term.focus()
        else inputRef.value?.focus()
      })
    }
  },
  { immediate: true }
)

// 传输模式切换：char 聚焦 xterm，line 聚焦本地输入条
watch(
  () => terminal.mode,
  (m) => {
    if (!props.active) return
    nextTick(() => {
      if (m === 'char') { if (opened) terminal.term.focus() }
      else inputRef.value?.focus()
    })
  }
)
</script>

<template>
  <div class="term-pane">
    <div class="toolbar">
      <NButtonGroup size="tiny">
        <NButton :type="terminal.mode === 'char' ? 'primary' : 'default'" @click="terminal.mode = 'char'">
          {{ t('terminal.charMode') }}
        </NButton>
        <NButton :type="terminal.mode === 'line' ? 'primary' : 'default'" @click="terminal.mode = 'line'">
          {{ t('terminal.lineMode') }}
        </NButton>
      </NButtonGroup>
      <NButton
        size="tiny"
        :type="terminal.echo ? 'primary' : 'default'"
        :title="t('terminal.echoTitle')"
        @click="terminal.echo = !terminal.echo"
      >
        {{ t('terminal.echo') }}
      </NButton>
      <NSelect
        v-model:value="terminal.lineEnding"
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

    <div ref="viewportRef" class="viewport" @click="focusTerm">
      <div v-if="showDroppedBar" class="dropped-bar">
        <span>{{ t('terminal.droppedLines', { n: terminal.droppedLines }) }}</span>
        <button type="button" class="dropped-dismiss" :title="t('terminal.cancel')" @click="droppedBarDismissed = true">✕</button>
      </div>
      <div ref="termHost" class="xterm-host"></div>
      <div v-if="showRaw" class="raw-dump">{{ terminal.rawDump }}</div>
      <Transition name="fade">
        <NButton v-if="!follow" class="jump-btn" size="small" type="primary" @click="scrollToBottom">
          {{ t('terminal.backToLatest') }}
        </NButton>
      </Transition>
    </div>

    <TerminalInput v-if="terminal.mode === 'line'" ref="inputRef" />
    <div v-else class="char-hint">
      {{ serial.connected ? t('terminal.inputCharHint') : t('terminal.needConnect') }}
    </div>
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
.xterm-host {
  position: absolute;
  inset: 0;
  padding: 4px 8px;
}
.xterm-host :deep(.xterm-viewport) {
  background: transparent !important;
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
.char-hint {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
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
