<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NButtonGroup, NSelect, useMessage } from 'naive-ui'
import { useClipboard } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { FitAddon } from '@xterm/addon-fit'
import TerminalInput from './TerminalInput.vue'
import { useSession } from '@/composables/useSession'
import { useTheme } from '@/composables/useTheme'
import { resolveTerminalPalette } from '@/themes'
import { resolveCharHintKind } from '@/utils/terminal-hint'
import { onViewTabReactivate } from '@/utils/dockview-events'
import type { DockviewPanelApi } from 'dockview-vue'

/**
 * 终端视图：xterm 视口（内置 cell 网格/SGR/回滚/alt-screen）+ 工具栏 + 输入条。
 * char 模式直接键入 xterm（onData 由 terminal store 下发）；line 模式渲染本地输入条。
 */
/** dockview 面板内容组件 props：params 内携带面板 api（激活状态/事件）。
 *  api 用完整类型（与 ViewTab 一致）——refocus 事件按 api 对象同一性过滤。 */
interface TerminalPanelParams {
  params?: unknown
  api: DockviewPanelApi
  containerApi: unknown
  tabLocation: string
}

const props = defineProps<{ params: TerminalPanelParams }>()
// 面板是否激活（dockview）：驱动聚焦与自适应。初始取 api.isActive，之后订阅事件。
const isActive = ref(props.params.api.isActive)

const { terminal, serial, settings, pause } = useSession()
const { t } = useI18n()
const toast = useMessage()
const { copy } = useClipboard()
const { theme: appTheme } = useTheme()

// 终端视口配色跟随主题：xterm 自绘不走 CSS 变量，须把主题的终端调色板
// 灌进 ITheme（主题切换/组件重挂载都会经 immediate watch 重灌，幂等）。
watch(
  () => resolveTerminalPalette(appTheme.value),
  (pal) => {
    terminal.term.options.theme = pal
  },
  { immediate: true }
)

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
// 上次同步给驱动的行列（fit 只在实际变化时 setSize，避免 ResizeObserver 反馈环）
let lastCols = 0
let lastRows = 0

const follow = ref(true)
const droppedBarDismissed = ref(false)
const showDroppedBar = computed(() => terminal.droppedLines > 0 && !droppedBarDismissed.value)
/** 调试：原始 RX 字节 hex 视图 */
const showRaw = ref(false)

// 直通模式底部提示：仅网络传输（RTT/TCP）渲染（见 resolveCharHintKind）。串口设备回显无歧义，
// 不显示提示；网络对端（如 nc、RTT Server）常无回显，本地回显关闭时输入不可见，必须警示。
const isTcpTransport = computed(() => serial.driverType === 'tcp' || serial.driverType === 'rtt')
const charHintKind = computed(() => resolveCharHintKind(serial.connected, terminal.echo, isTcpTransport.value))
const charHint = computed(() => {
  switch (charHintKind.value) {
    case 'needConnect': return t('terminal.needConnect')
    case 'echoOn': return t('terminal.inputCharHintEcho')
    case 'tcpNoEcho': return t('terminal.inputCharHintNoEcho')
    default: return null // hidden：串口不渲染提示条
  }
})
const charHintWarn = computed(() => charHintKind.value === 'tcpNoEcho')

/** 首次挂载：xterm.open + FitAddon + 跟随滚动监听 */
function ensureOpen() {
  if (opened || !termHost.value) return
  opened = true
  // xterm 实例是会话级（terminal store），本组件却可能被 dockview 重挂载（切端口触发
  // restoreLayout→fromJSON，reuseExistingPanels 只复用面板对象不保组件）。此时 term 已绑在
  // 前一组件树的 host 上，xterm 对二次 open() 是静默 no-op（CoreBrowserTerminal.open 对已
  // 打开实例提前 return），必须把既有 .xterm DOM 迁移进新 host——否则终端空壳，focus/打字
  // 全部落在一颗游离节点上（真机表现：终端空白、TX 0、琥珀焦点圈圈住内容区）。
  if (terminal.term.element) {
    termHost.value.appendChild(terminal.term.element)
  } else {
    terminal.term.open(termHost.value)
  }
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
  // dockview 隐藏面板（renderContainer）可能是「宽有值、高为 0」，此时 fit 会算出
  // 0 行并反复 resize 触发 RO 反馈环，故宽高任一为 0 都跳过
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return
  fitAddon?.fit()
  const cols = terminal.term.cols
  const rows = terminal.term.rows
  // 行列未变化时跳过 setSize（fitAddon 已在内部重算，无谓同步会触发尺寸反馈循环）
  if (cols === lastCols && rows === lastRows) return
  lastCols = cols
  lastRows = rows
  // 设置里显式指定行列时覆盖 FitAddon
  const s = settings.terminal
  if (s.cols > 0 || s.rows > 0) {
    terminal.setSize(s.cols || cols, s.rows || rows)
  }
  // 同步视口尺寸到驱动（pty 本地 shell 的 stty 感知；serialport 等无 setSize 则 no-op）
  serial.setSize(cols, rows)
}

function scrollToBottom() {
  terminal.term.scrollToBottom()
  follow.value = true
}

function focusTerm() {
  if (terminal.mode === 'char' && opened) terminal.term.focus()
}

/** 面板激活时的聚焦：char 聚焦 xterm，line 聚焦本地输入条 */
function focusActive() {
  if (!isActive.value) return
  if (terminal.mode === 'char') {
    if (opened) terminal.term.focus()
  } else {
    inputRef.value?.focus()
  }
}

/**
 * 激活后聚焦需躲开原生抢焦：dockview 在 pointerdown 激活面板，紧随其后的 mousedown
 * 默认行为会把 DOM 焦点交给 .dv-tab（tabindex roving），nextTick 微任务聚焦会输给
 * 这一步（真机埋点实测 focusout dv-tab 晚 textarea.focus 1ms）。rAF 已过 mousedown，
 * 再补一个 setTimeout(0) 重申兜底；两次调用均幂等，isActive 守卫防失活后误聚焦。
 */
function focusSoon() {
  nextTick(() => {
    ensureOpen()
    fit()
    requestAnimationFrame(() => {
      focusActive()
      setTimeout(focusActive, 0)
    })
  })
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

let apiSub: { dispose(): void } | null = null

// ViewTab 点击「已激活」的终端 tab 时把输入焦点拉回 xterm/行输入条：
// dockview 对此 no-op（无激活事件），焦点滞留 .dv-tab 上，Enter/打字会被吞掉。
// 契约与 api 同一性过滤见 utils/dockview-events。
let disposeReactivate: (() => void) | null = null

onMounted(() => {
  disposeReactivate = onViewTabReactivate(props.params.api, focusSoon)
  ro = new ResizeObserver(() => {
    if (opened) fit()
  })
  if (viewportRef.value) ro.observe(viewportRef.value)
  // renderer:'always' 下组件常驻：挂载即初始化 xterm，尺寸由 ResizeObserver 跟随。
  // focusSoon 内 ensureOpen/fit 无条件执行（失活面板也要渲染），聚焦由 focusActive
  // 的 isActive 守卫按激活态放行。
  focusSoon()
  // 面板激活/失活（dockview 拖拽/切 tab 均触发）：激活时聚焦 + 自适应
  apiSub = props.params.api.onDidActiveChange((e) => {
    isActive.value = e.isActive
    if (e.isActive) focusSoon()
  })
})

onBeforeUnmount(() => {
  disposeReactivate?.()
  disposeReactivate = null
  apiSub?.dispose()
  apiSub = null
  ro?.disconnect()
  ro = null
  // xterm 实例生命周期由 terminal store 的 onScopeDispose 统一 dispose（会话关闭时）
})

// 传输模式切换：char 聚焦 xterm，line 聚焦本地输入条（仅面板激活时）
watch(
  () => terminal.mode,
  (m) => {
    if (!isActive.value) return
    nextTick(() => {
      if (m === 'char') { if (opened) terminal.term.focus() }
      else inputRef.value?.focus()
    })
  }
)

// 连接建立即回焦：点「连接」后焦点滞留按钮上，随后的打字/回车会被按钮吞掉
// （回车=再次触发按钮，等于误触断连），终端是连接后最直接的输入面。
// 用户正在可编辑元素打字时不抢（自动重连场景下保护发送框输入）。
watch(
  () => serial.connected,
  (c) => {
    if (!c || !isActive.value) return
    const ae = document.activeElement
    const editing = ae instanceof HTMLElement && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    if (!editing) focusSoon()
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
    <div v-else-if="charHint" class="char-hint" :class="{ warn: charHintWarn }">
      {{ charHint }}
    </div>
  </div>
</template>

<style scoped>
.term-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  /* dockview 下父容器（.dv-vue-part）是 block 非 flex，flex:1 不生效，须显式定高，
     否则 viewport 高度塌陷为 0（xterm 不可见、提示条覆盖输入区） */
  height: 100%;
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
/* 回显关闭：输入对用户不可见，用警示色提示去向（区别于普通提示） */
.char-hint.warn {
  color: var(--warn);
  border-top-color: var(--warn);
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
