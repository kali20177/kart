<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useSession } from '@/composables/useSession'
import { useSendHistory } from '@/composables/useSendHistory'
import { concatBytes, lineEndingBytes } from '@/utils/encoding'
import type { LineEnding } from '@/types'

/**
 * 终端输入条（仅 line 模式）：本地行编辑（原生 input）+ Enter 发送整行 + ↑/↓ 历史。
 * char 模式不再需要本组件——xterm 自身即输入焦点，按键经 term.onData 由 terminal store 下发。
 */
const { serial, terminal } = useSession()
const { t } = useI18n()
const toast = useMessage()
const history = useSendHistory()

const line = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const enc = (s: string) => new TextEncoder().encode(s)

const endingStr: Record<LineEnding, string> = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }

function sendBytes(bytes: Uint8Array) {
  void terminal.sendBytes(bytes).then((r) => {
    if (!r.ok) toast.error(r.error ?? t('terminal.sendFailed'))
  })
}

/** Ctrl 组合 → 控制字节（保证 Ctrl+C 中断可用），本地编辑不拦截 */
function ctrlToBytes(key: string): Uint8Array | null {
  const c = key.toUpperCase()
  if (c.length === 1 && c >= 'A' && c <= 'Z') return new Uint8Array([c.charCodeAt(0) - 64])
  switch (key) {
    case '[': return new Uint8Array([0x1b])
    case '\\': return new Uint8Array([0x1c])
    case ']': return new Uint8Array([0x1d])
    case '^': return new Uint8Array([0x1e])
    case '_': return new Uint8Array([0x1f])
  }
  return null
}

function onKeydown(e: KeyboardEvent) {
  if (!serial.connected) return
  if (e.metaKey) return // 保留系统快捷键（Cmd+C/V 等）
  if (e.isComposing) return

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
    const bytes = ctrlToBytes(e.key)
    if (bytes) {
      e.preventDefault()
      sendBytes(bytes)
    }
  }
  // 其余按键走原生输入（本地行编辑）
}

function sendLine() {
  const text = line.value
  if (!text) return
  const ending = terminal.lineEnding
  const bytes = concatBytes(enc(text), lineEndingBytes(ending))
  sendBytes(bytes)
  if (terminal.echo) terminal.echoText(text + endingStr[ending])
  history.add(text)
  line.value = ''
}

function onInput(e: Event) {
  line.value = (e.target as HTMLInputElement).value
}

function focus() {
  inputEl.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="term-input" @click="focus">
    <span class="input-prompt">{{ t('terminal.inputPrompt') }}</span>
    <input
      ref="inputEl"
      class="input"
      :value="line"
      :placeholder="serial.connected ? t('terminal.inputLinePlaceholder') : t('terminal.needConnect')"
      :disabled="!serial.connected"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @keydown="onKeydown"
      @input="onInput"
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
