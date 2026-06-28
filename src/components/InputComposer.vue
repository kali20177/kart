<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { NInput, NButton, NButtonGroup, NSelect, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useSerialStore } from '@/stores/serial'
import { useSettingsStore } from '@/stores/settings'
import { useSendHistory } from '@/composables/useSendHistory'
import { parseHexInput, bytesToHex } from '@/utils/hex'
import { encodeWithEscapes } from '@/utils/encoding'
import type { DataMode, LineEnding } from '@/types'

const text = defineModel<string>('text', { default: '' })
const mode = defineModel<DataMode>('mode', { default: 'ascii' })

const serial = useSerialStore()
const settings = useSettingsStore()
const message = useMessage()
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
    if (r.ok) return { ok: true, msg: `${r.bytes.length} 字节` }
    return { ok: false, msg: r.error ?? '解析失败' }
  }

  // ASCII 模式：展示转义解析后的实际发送字节（不含行尾，行尾在 selector 里可见）
  const body = encodeWithEscapes(text.value)
  return { ok: true, msg: `${bytesToHex(body)}  (${body.length} 字节)` }
})

async function sendOnce(): Promise<boolean> {
  if (!serial.connected) {
    message.warning('请先连接端口')
    return false
  }
  const r = await serial.send(text.value, mode.value, lineEnding.value, settings.settings.encoding)
  if (!r.ok) {
    message.error(r.error ?? '发送失败')
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
    message.warning('请先连接端口')
    return
  }
  repeatSent.value = 0
  const total = repeatCount.value
  const interval = Math.max(10, repeatInterval.value)
  message.info(
    total > 0
      ? `开始循环发送 · 共 ${total} 次 · 间隔 ${interval} ms`
      : `开始循环发送 · 无限次 · 间隔 ${interval} ms`,
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
    message.success(`循环发送完成 · 共发送 ${repeatSent.value} 次`, { duration: 3000 })
  } else if (reason === 'manual') {
    message.info(`循环发送已停止 · 已发送 ${repeatSent.value} 次`, { duration: 2000 })
  } else if (reason === 'disconnect') {
    message.warning(`连接断开，循环已停止 · 已发送 ${repeatSent.value} 次`, { duration: 3000 })
  }
  // silent: 不提示（卸载、或发送错误已自行弹窗）
}

function toggleRepeat() {
  if (repeating.value) stopRepeat('manual')
  else startRepeat()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
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
</script>

<template>
  <div class="composer">
    <div class="chips">
      <NButtonGroup size="tiny">
        <NButton :type="mode === 'ascii' ? 'primary' : 'default'" @click="mode = 'ascii'">ASCII</NButton>
        <NButton :type="mode === 'hex' ? 'primary' : 'default'" @click="mode = 'hex'">HEX</NButton>
      </NButtonGroup>

      <span class="lbl">行尾</span>
      <NSelect v-model:value="lineEnding" :options="endingOptions" size="tiny" style="width: 84px" />

      <span class="lbl">循环</span>
      <NSwitch v-model:value="repeatOn" size="small" />
      <template v-if="repeatOn">
        <NInputNumber v-model:value="repeatInterval" size="tiny" :min="10" :step="100" style="width: 110px">
          <template #suffix>ms</template>
        </NInputNumber>
        <NInputNumber v-model:value="repeatCount" size="tiny" :min="0" style="width: 96px" placeholder="次数">
          <template #suffix>次</template>
        </NInputNumber>
        <span v-if="repeating" class="repeat-count">
          <span class="dot" />
          {{ repeatSent }}{{ repeatCount > 0 ? '/' + repeatCount : '' }}
        </span>
      </template>

      <span v-if="sendPreview" class="hint" :class="{ bad: !sendPreview.ok }">{{ sendPreview.msg }}</span>
    </div>

    <div class="input-row">
      <NInput
        v-model:value="text"
        type="text"
        :placeholder="mode === 'hex' ? '输入 HEX，如 AA 55 01 0x02 ；Enter 发送，Alt+↑/↓ 翻历史' : '输入文本，支持 \\r \\n \\t \\\\ \\0 \\xHH ；Enter 发送，Alt+↑/↓ 翻历史'"
        class="mono"
        @keydown="onKeydown"
      />
      <span v-if="repeatOn" class="loop-btn-wrap" :class="{ 'is-looping': repeating }">
        <NButton
          :type="repeating ? 'error' : 'warning'"
          @click="toggleRepeat"
        >
          <template v-if="repeating">
            <span class="spinner" />
            停止
          </template>
          <template v-else>开始循环</template>
        </NButton>
      </span>
      <NButton type="primary" :disabled="repeating" @click="onSend">发送</NButton>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: none;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  padding: 8px 12px;
}
.chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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
  border-radius: 50%;
  background: var(--accent, #18a058);
  box-shadow: 0 0 0 0 currentColor;
  animation: loop-pulse 1.2s ease-out infinite;
}
.hint {
  font-size: 12px;
  color: var(--ok);
  margin-left: auto;
  font-family: var(--mono-font);
}
.hint.bad {
  color: var(--err);
}
.input-row {
  display: flex;
  gap: 8px;
}
.mono :deep(input) {
  font-family: var(--mono-font);
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
.loop-btn-wrap {
  position: relative;
  display: inline-flex;
  border-radius: 4px;
}
.loop-btn-wrap.is-looping {
  animation: loop-scale 1.2s ease-in-out infinite;
}
.loop-btn-wrap.is-looping::after {
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
</style>
