<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { NInput, NButton, NButtonGroup, NSelect, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useSerialStore } from '@/stores/serial'
import { useSettingsStore } from '@/stores/settings'
import { useSendHistory } from '@/composables/useSendHistory'
import { parseHexInput } from '@/utils/hex'
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
const repeating = computed(() => repeatTimer != null)

// HEX 解析实时提示
const hexHint = computed(() => {
  if (mode.value !== 'hex' || !text.value.trim()) return null
  const r = parseHexInput(text.value)
  if (r.ok) return { ok: true, msg: `${r.bytes.length} 字节` }
  return { ok: false, msg: r.error ?? '解析失败' }
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

function startRepeat() {
  if (!serial.connected) {
    message.warning('请先连接端口')
    return
  }
  repeatSent.value = 0
  repeatTimer = setInterval(async () => {
    const ok = await sendOnce()
    if (!ok) {
      stopRepeat()
      return
    }
    repeatSent.value++
    if (repeatCount.value > 0 && repeatSent.value >= repeatCount.value) stopRepeat()
  }, Math.max(10, repeatInterval.value))
}

function stopRepeat() {
  if (repeatTimer) {
    clearInterval(repeatTimer)
    repeatTimer = null
  }
}

function toggleRepeat() {
  if (repeating.value) stopRepeat()
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

onBeforeUnmount(stopRepeat)
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
        <span v-if="repeating" class="repeat-count">{{ repeatSent }}{{ repeatCount > 0 ? '/' + repeatCount : '' }}</span>
      </template>

      <span v-if="hexHint" class="hint" :class="{ bad: !hexHint.ok }">{{ hexHint.msg }}</span>
    </div>

    <div class="input-row">
      <NInput
        v-model:value="text"
        type="text"
        :placeholder="mode === 'hex' ? '输入 HEX，如 AA 55 01 0x02 ；Enter 发送，Ctrl+↑/↓ 翻历史' : '输入文本；Enter 发送，Ctrl+↑/↓ 翻历史'"
        class="mono"
        @keydown="onKeydown"
      />
      <NButton
        v-if="repeatOn"
        :type="repeating ? 'error' : 'warning'"
        @click="toggleRepeat"
      >
        {{ repeating ? '停止' : '开始循环' }}
      </NButton>
      <NButton type="primary" :disabled="repeating" @click="onSend">发送</NButton>
    </div>
  </div>
</template>

<style scoped>
.composer {
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
  font-size: 12px;
  color: var(--accent);
  font-family: var(--mono-font);
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
</style>
