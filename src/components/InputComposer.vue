<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue'
import { useStorage, useEventListener } from '@vueuse/core'
import { NInput, NButton, NButtonGroup, NSelect, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/composables/useSession'
import { useSendHistory } from '@/composables/useSendHistory'
import SendHistoryPopover from './SendHistoryPopover.vue'
import { STORAGE_PREFIX } from '@/composables/useStorage'
import { parseHexInput, bytesToHex } from '@/utils/hex'
import { encodeWithEscapes } from '@/utils/encoding'
import type { DataMode, LineEnding } from '@/types'

const text = defineModel<string>('text', { default: '' })
const mode = defineModel<DataMode>('mode', { default: 'ascii' })

const emit = defineEmits<{
  (e: 'open-file-transfer', file?: File): void
}>()

const { serial, settings, checksum } = useSession()
const message = useMessage()
const { t } = useI18n()
const history = useSendHistory()

const lineEnding = ref<LineEnding>('crlf')
const endingOptions = [
  { label: '无', value: 'none' },
  { label: '\\r', value: 'cr' },
  { label: '\\n', value: 'lf' },
  { label: '\\r\\n', value: 'crlf' }
]

// 循环发送
const repeatOn = ref(false)
const repeatInterval = ref(1000)
const repeatCount = ref(0) // 0 = 无限
let repeatTimer: ReturnType<typeof setInterval> | null = null
const repeatSent = ref(0)
const repeating = ref(false)

// 发送预览：HEX 模式显示解析结果，ASCII 模式显示转义后的实际字节
const sendPreview = computed(() => {
  if (!text.value.trim()) return null

  if (mode.value === 'hex') {
    const r = parseHexInput(text.value)
    if (r.ok) return { ok: true, msg: t('composer.byteCount', { n: r.bytes.length }) }
    return { ok: false, msg: r.error ?? t('composer.parseFailed') }
  }

  // ASCII 模式：展示转义解析后的实际发送字节（不含行尾，行尾在 selector 里可见）
  const body = encodeWithEscapes(text.value)
  return { ok: true, msg: `${bytesToHex(body)}  (${t('composer.byteCount', { n: body.length })})` }
})

async function sendOnce(): Promise<boolean> {
  if (!serial.connected) {
    message.warning(t('composer.needConnect'))
    return false
  }
  const r = await serial.send(text.value, mode.value, lineEnding.value, settings.encoding, checksum.send)
  if (!r.ok) {
    message.error(r.error ?? t('composer.sendFailed'))
    return false
  }
  return true
}

async function onSend() {
  const ok = await sendOnce()
  if (ok && text.value.trim()) history.add(text.value)
}

type StopReason = 'manual' | 'completed' | 'disconnect' | 'silent'

function startRepeat() {
  if (!serial.connected) {
    message.warning(t('composer.needConnect'))
    return
  }
  repeatSent.value = 0
  const total = repeatCount.value
  const interval = Math.max(10, repeatInterval.value)
  message.info(
    total > 0
      ? t('composer.loopStartCount', { total, interval })
      : t('composer.loopStartInfinite', { interval }),
    { duration: 2000 }
  )
  repeating.value = true
  repeatTimer = setInterval(async () => {
    const ok = await sendOnce()
    if (!ok) {
      // sendOnce 已弹错误提示，这里静默停
      stopRepeat('silent')
      return
    }
    repeatSent.value++
    if (repeatCount.value > 0 && repeatSent.value >= repeatCount.value) {
      stopRepeat('completed')
    }
  }, interval)
}

function stopRepeat(reason: StopReason = 'manual') {
  if (!repeatTimer) return
  clearInterval(repeatTimer)
  repeatTimer = null
  repeating.value = false
  if (reason === 'completed') {
    message.success(t('composer.loopDone', { n: repeatSent.value }), { duration: 3000 })
  } else if (reason === 'manual') {
    message.info(t('composer.loopStopped', { n: repeatSent.value }), { duration: 2000 })
  } else if (reason === 'disconnect') {
    message.warning(t('composer.loopDisconnect', { n: repeatSent.value }), { duration: 3000 })
  }
  // silent: 不提示（卸载、或发送错误已自行弹窗）
}

function toggleRepeat() {
  if (repeating.value) stopRepeat('manual')
  else startRepeat()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    // Ctrl/Cmd+Enter 发送；普通 Enter 留给 textarea 插入换行（仅视觉分隔，不发送字节）
    e.preventDefault()
    onSend()
  } else if (e.key === 'ArrowUp' && (e.ctrlKey || e.altKey)) {
    e.preventDefault()
    const v = history.prev()
    if (v != null) text.value = v
  } else if (e.key === 'ArrowDown' && (e.ctrlKey || e.altKey)) {
    e.preventDefault()
    const v = history.next()
    if (v != null) text.value = v
  }
}

// 关掉循环开关时自动停止
watch(repeatOn, (on) => { if (!on) stopRepeat('manual') })
// 断开连接时自动停止
watch(() => serial.connected, (c) => { if (!c) stopRepeat('disconnect') })

onBeforeUnmount(() => stopRepeat('silent'))

// —— 文件拖入 ——
const dragOver = ref(false)

function onDragOver(e: DragEvent) {
  e.preventDefault()
  dragOver.value = true
}

function onDragLeave() {
  dragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) emit('open-file-transfer', file)
}

function onOpenFileTransfer() {
  emit('open-file-transfer')
}

// —— 输入框高度拖拽 ——
// Naive UI 原生 resize 手柄在右下角且为「向上压」语义，交互反直觉；
// 这里改用输入框上边缘的横向拖拽条：向上拖增大、向下拖减小。
const inputComp = ref<InstanceType<typeof NInput> | null>(null)
const MIN_H = 40
const MAX_H = 360
const INPUT_HEIGHT_KEY = STORAGE_PREFIX + 'composer:inputHeight'
const inputHeight = useStorage(INPUT_HEIGHT_KEY, MIN_H * 2)
let dragStartY = 0
let dragStartH = 0
let stopMove: (() => void) | null = null

function getTextarea(): HTMLTextAreaElement | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = (inputComp.value as any)?.$el as HTMLElement | undefined
  return el ? el.querySelector('textarea') : null
}

function onGripDown(e: PointerEvent) {
  const ta = getTextarea()
  if (!ta) return
  e.preventDefault()
  dragStartY = e.clientY
  dragStartH = ta.getBoundingClientRect().height
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  // 拖拽期间动态注册，pointerup 时通过返回的 cleanup 解绑
  stopMove = useEventListener(window, 'pointermove', onGripMove)
  useEventListener(window, 'pointerup', onGripUp, { once: true })
}

function onGripMove(e: PointerEvent) {
  const ta = getTextarea()
  if (!ta) return
  // grip 在上边缘：向上拖（delta 为负）增大高度
  let h = dragStartH - (e.clientY - dragStartY)
  h = Math.max(MIN_H, Math.min(MAX_H, h))
  ta.style.height = `${h}px`
}

function onGripUp() {
  stopMove?.()
  stopMove = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  const ta = getTextarea()
  if (ta) {
    const h = parseFloat(ta.style.height)
    if (h >= MIN_H && h <= MAX_H) inputHeight.value = h
  }
}

onMounted(async () => {
  await nextTick()
  const ta = getTextarea()
  if (ta) ta.style.height = `${inputHeight.value}px`
})

/** 「恢复默认设置」时就地重置输入框高度 */
function onResetLayout() {
  inputHeight.value = MIN_H * 2
  const ta = getTextarea()
  if (ta) ta.style.height = `${MIN_H * 2}px`
}

// setup 期注册，组件卸载时 useEventListener 自动解绑
useEventListener(window, 'app:reset-layout', onResetLayout)

onBeforeUnmount(() => {
  // 兜底：拖拽进行中卸载时清理 pointermove
  stopMove?.()
})
</script>

<template>
  <div class="composer" :class="{ 'drag-over': dragOver }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <div class="chips">
      <NButtonGroup size="tiny">
        <NButton :type="mode === 'ascii' ? 'primary' : 'default'" @click="mode = 'ascii'">ASCII</NButton>
        <NButton :type="mode === 'hex' ? 'primary' : 'default'" @click="mode = 'hex'">HEX</NButton>
      </NButtonGroup>

      <span class="lbl">{{ t('composer.lineEnding') }}</span>
      <NSelect v-model:value="lineEnding" :options="endingOptions" size="tiny" style="width: 84px" />

      <span class="lbl">{{ t('composer.loop') }}</span>
      <NSwitch v-model:value="repeatOn" size="small" />
      <template v-if="repeatOn">
        <NInputNumber v-model:value="repeatInterval" size="tiny" :min="10" :step="100" style="width: 110px">
          <template #suffix>ms</template>
        </NInputNumber>
        <NInputNumber v-model:value="repeatCount" size="tiny" :min="0" style="width: 96px" :placeholder="t('composer.count')">
          <template #suffix>{{ t('composer.count') }}</template>
        </NInputNumber>
        <span v-if="repeating" class="repeat-count">
          <span class="dot" />
          {{ repeatSent }}{{ repeatCount > 0 ? '/' + repeatCount : '' }}
        </span>
      </template>

      <div class="spacer" />
      <SendHistoryPopover @to-composer="(t: string) => text = t" />
    </div>

    <div v-if="sendPreview" class="preview-row" :class="{ bad: !sendPreview.ok }">{{ sendPreview.msg }}</div>

    <div class="input-row">
      <div class="input-wrap">
        <div class="grip" @pointerdown="onGripDown" :title="t('composer.dragResize')" />
        <NInput
          ref="inputComp"
          v-model:value="text"
          type="textarea"
          :rows="2"
          :resizable="false"
          :placeholder="mode === 'hex' ? t('composer.hexPlaceholder') : t('composer.asciiPlaceholder')"
          class="mono"
          @keydown="onKeydown"
        />
      </div>
      <NButton :title="t('fileTransfer.attachFile')" @click="onOpenFileTransfer" :disabled="repeating" style="margin-right: 4px">📎</NButton>
      <span class="send-btn-wrap" :class="{ 'is-looping': repeatOn && repeating }">
        <NButton
          :type="repeatOn && repeating ? 'error' : 'primary'"
          @click="repeatOn ? toggleRepeat() : onSend()"
        >
          <template v-if="repeatOn && repeating">
            <span class="spinner" />
            {{ t('composer.stop') }}
          </template>
          <template v-else>{{ t('composer.send') }}</template>
        </NButton>
      </span>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: none;
  border-top: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  padding: 8px 12px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
  position: relative;
  z-index: 2;
}
.chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.lbl {
  font-size: 12px;
  color: var(--text-dim);
}
.repeat-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--accent);
  font-family: var(--mono-font);
}
.repeat-count .dot {
  width: 8px;
  height: 8px;
  border-radius: var(--pill-radius);
  background: var(--accent, #18a058);
  box-shadow: 0 0 0 0 currentColor;
  animation: loop-pulse 1.2s ease-out infinite;
}
.spacer {
  flex: 1;
}
.preview-row {
  font-size: 12px;
  color: var(--ok);
  font-family: var(--mono-font);
  margin-bottom: 6px;
  line-height: 1.4;
  word-break: break-all;
  max-height: 3.6em;
  overflow-y: auto;
}
.preview-row.bad {
  color: var(--err);
}
.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.mono :deep(textarea) {
  font-family: var(--mono-font);
  resize: none;
  background: var(--bg-elevated);
}
/* 输入框上边缘横向拖拽手柄：向上拖增大、向下拖减小 */
.grip {
  flex: none;
  height: 8px;
  margin-bottom: 2px;
  cursor: row-resize;
  border-bottom: 1px solid var(--glass-border);
  position: relative;
}
.grip::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 32px;
  height: 3px;
  border-radius: 2px;
  background: var(--text-dim);
  opacity: 0.4;
  transition: opacity 0.15s;
}
.grip:hover::before {
  opacity: 0.9;
}

/* 循环中的「停止」按钮：旋转图标 + 呼吸光晕 */
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  vertical-align: -2px;
  animation: loop-spin 0.8s linear infinite;
}
/* 用 wrapper + ::after 做光晕，避免被 Naive UI 自带的 box-shadow 覆盖 */
.send-btn-wrap {
  position: relative;
  display: inline-flex;
  border-radius: var(--radius);
}
.send-btn-wrap.is-looping {
  animation: loop-scale 1.2s ease-in-out infinite;
}
.send-btn-wrap.is-looping::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  animation: loop-glow 1.2s ease-out infinite;
}
@keyframes loop-spin {
  to { transform: rotate(360deg); }
}
@keyframes loop-scale {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.04); }
}
@keyframes loop-glow {
  0%   { box-shadow: 0 0 0 0 rgba(208, 48, 80, 0.7); }
  70%  { box-shadow: 0 0 0 10px rgba(208, 48, 80, 0); }
  100% { box-shadow: 0 0 0 0 rgba(208, 48, 80, 0); }
}
@keyframes loop-pulse {
  0%   { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
  70%  { box-shadow: 0 0 0 6px transparent; opacity: 0.6; }
  100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
}

/* 文件拖入高亮 */
.composer.drag-over {
  border-top-color: var(--accent);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15), inset 0 0 0 2px var(--accent);
}
</style>
