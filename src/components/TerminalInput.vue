<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useSession } from '@/composables/useSession'
import { useSendHistory } from '@/composables/useSendHistory'
import { concatBytes, lineEndingBytes } from '@/utils/encoding'
import { keyToBytes } from '@/terminal/input-map'
import type { LineEnding } from '@/types'

/**
 * 终端输入（行规）：
 * - char 模式：按键即时透传（含方向/功能键转义序列、Ctrl 控制字节），适配设备侧行编辑+回显
 *   （嵌入式 Linux console / Letter Shell）；本地回显由 echo 开关决定（默认关，设备回显）。
 * - line 模式：本地行编辑（原生 input）+ Enter 发送整行 + 历史（↑/↓）。
 */
const props = defineProps<{
  mode: 'line' | 'char'
  echo: boolean
  lineEnding: LineEnding
  backspace: 'del' | 'bs'
}>()

const { serial, terminal } = useSession()
const { t } = useI18n()
const toast = useMessage()
const history = useSendHistory()

const line = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const isChar = computed(() => props.mode === 'char')

const enc = (s: string) => new TextEncoder().encode(s)

function sendBytes(bytes: Uint8Array) {
  void terminal.sendBytes(bytes).then((r) => {
    if (!r.ok) toast.error(r.error ?? t('terminal.sendFailed'))
  })
}

/** 发送 + 本地回显（echo 策略在此，store 只负责裸下发） */
function emitBytes(bytes: Uint8Array) {
  sendBytes(bytes)
  if (props.echo) terminal.injectLocal(bytes)
}

function onKeydown(e: KeyboardEvent) {
  if (!serial.connected) return
  if (e.metaKey) return // 保留系统快捷键（Cmd+C/V 等）
  if (e.isComposing) return

  if (isChar.value) {
    const bytes = keyToBytes(e, props.backspace, props.lineEnding)
    if (bytes) {
      e.preventDefault()
      emitBytes(bytes)
    } else if (e.ctrlKey) {
      e.preventDefault()
    }
    return
  }

  // line 模式
  if (e.key === 'Enter') {
    e.preventDefault()
    sendLine()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const v = history.prev()
    if (v != null) line.value = v
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    const v = history.next()
    if (v != null) line.value = v
  } else if (e.ctrlKey) {
    // Ctrl 组合透传为控制字节（保证 Ctrl+C 中断可用），本地编辑不拦截
    const bytes = keyToBytes(e, props.backspace, props.lineEnding)
    if (bytes) {
      e.preventDefault()
      emitBytes(bytes)
    }
  }
  // 其余按键走原生输入（本地行编辑）
}

function sendLine() {
  const text = line.value
  if (!text) return
  emitBytes(concatBytes(enc(text), lineEndingBytes(props.lineEnding)))
  history.add(text)
  line.value = ''
}

function onInput(e: Event) {
  line.value = (e.target as HTMLInputElement).value
}

function onPaste(e: ClipboardEvent) {
  if (!isChar.value) return
  e.preventDefault()
  const text = e.clipboardData?.getData('text') ?? ''
  if (text) emitBytes(enc(text))
}

function focus() {
  inputEl.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="term-input" :class="{ char: isChar }" @click="focus">
    <span class="input-hint" v-if="isChar">{{ t('terminal.inputCharHint') }}</span>
    <span class="input-prompt" v-else>{{ t('terminal.inputPrompt') }}</span>
    <input
      ref="inputEl"
      class="input"
      :value="line"
      :readonly="isChar"
      :placeholder="serial.connected ? (isChar ? '' : t('terminal.inputLinePlaceholder')) : t('terminal.needConnect')"
      :disabled="!serial.connected"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @keydown="onKeydown"
      @input="onInput"
      @paste="onPaste"
    />
  </div>
</template>

<style scoped>
.term-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-family: var(--mono-font);
  font-size: 13px;
}
.term-input.char {
  background: var(--bg-panel);
}
.input-hint {
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}
.input-prompt {
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}
.input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--mono-font);
  font-size: 13px;
  caret-color: var(--accent);
}
.input::placeholder {
  color: var(--text-dim);
  opacity: 0.7;
}
.input:disabled {
  color: var(--text-dim);
}
</style>
