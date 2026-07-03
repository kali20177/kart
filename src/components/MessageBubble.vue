<script setup lang="ts">
import { computed } from 'vue'
import { useMessage } from 'naive-ui'
import type { DataMode, Encoding, Message } from '@/types'
import { bytesToHex, hexDump } from '@/utils/hex'
import { decodeBytes } from '@/utils/encoding'
import { formatMessageLine, formatTimestamp } from '@/utils/message-format'

const props = defineProps<{
  message: Message
  viewMode: DataMode
  encoding: Encoding
  /** 多选模式：显示勾选圈、左键切换选中、隐藏单条操作按钮 */
  selectable?: boolean
  selected?: boolean
}>()

const emit = defineEmits<{
  (e: 'resend', bytes: Uint8Array): void
  (e: 'select'): void
  (e: 'contextmenu', ev: MouseEvent): void
}>()

const toast = useMessage()

const isTx = computed(() => props.message.direction === 'tx')

const timeLabel = computed(() => formatTimestamp(props.message.timestamp, 'short'))

const asciiText = computed(() => decodeBytes(props.message.bytes, props.encoding))
const dumpLines = computed(() => hexDump(props.message.bytes, 16))

/** 复制本帧：带时间戳 + 方向前缀，与气泡显示时间一致 */
function copyCurrent() {
  navigator.clipboard?.writeText(
    formatMessageLine(props.message, {
      viewMode: props.viewMode,
      encoding: props.encoding,
      timeStyle: 'short'
    })
  )
  toast.success('已复制')
}

/** 复制为纯 HEX（不带前缀，喂脚本 / 编辑器用） */
function copyHex() {
  navigator.clipboard?.writeText(bytesToHex(props.message.bytes))
  toast.success('已复制')
}

/** 多选模式下左键切换选中；非多选不响应（气泡本身不可点） */
function onRowClick() {
  if (props.selectable) emit('select')
}

/** 右键：屏蔽浏览器默认菜单，交由父组件进入 / 切换多选 */
function onRowContext(e: MouseEvent) {
  e.preventDefault()
  emit('contextmenu', e)
}
</script>

<template>
  <div
    class="row"
    :class="[isTx ? 'row-tx' : 'row-rx', { selectable, selected }]"
    @click="onRowClick"
    @contextmenu="onRowContext"
  >
    <span v-if="selectable" class="check" :class="{ checked: selected }">{{ selected ? '✓' : '' }}</span>
    <div class="bubble" :class="isTx ? 'bubble-tx' : 'bubble-rx'">
      <div class="meta">
        <span class="dir">{{ isTx ? 'TX ▸' : '◂ RX' }}</span>
        <span class="time">{{ timeLabel }}</span>
        <span class="len">{{ message.bytes.length }} B</span>
        <span class="mode-badge">{{ viewMode === 'hex' ? 'HEX' : 'ASCII' }}</span>
        <span v-if="message.error" class="err-badge">⚠ {{ message.error }}</span>
        <span class="spacer" />
        <span v-if="!selectable" class="actions">
          <button title="复制本帧（带时间戳与方向）" @click="copyCurrent">复制</button>
          <button title="复制为 HEX" @click="copyHex">Hex</button>
          <button v-if="isTx" title="再次发送" @click="emit('resend', message.bytes)">重发</button>
        </span>
      </div>

      <!-- ASCII 视图 -->
      <pre v-if="viewMode === 'ascii'" class="body ascii">{{ asciiText }}</pre>

      <!-- HEX 视图：左 offset / 中 hex / 右 ASCII 透视 -->
      <div v-else class="body hex">
        <div v-for="(line, i) in dumpLines" :key="i" class="hex-line">
          <span class="off">{{ line.offset }}</span>
          <span class="hx">{{ line.hex }}</span>
          <span class="asc">{{ line.ascii }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  padding: 3px 14px;
}
.row.selectable {
  cursor: pointer;
}
.row-rx {
  justify-content: flex-start;
}
.row-tx {
  justify-content: flex-end;
}
.check {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0 6px;
  align-self: center;
  border: 1.5px solid var(--border);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  color: transparent;
  background: var(--bg-panel);
  user-select: none;
}
.check.checked {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.row.selected .bubble {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.bubble {
  max-width: 78%;
  border: 1px solid;
  border-radius: var(--radius);
  padding: 5px 9px 7px;
}
.bubble-rx {
  background: var(--rx-bg);
  border-color: var(--rx-border);
  color: var(--rx-text);
}
.bubble-tx {
  background: var(--tx-bg);
  border-color: var(--tx-border);
  color: var(--tx-text);
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 3px;
  white-space: nowrap;
}
.dir {
  font-weight: 600;
}
.mode-badge {
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
}
.err-badge {
  color: var(--err);
}
.spacer {
  flex: 1;
}
.actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.bubble:hover .actions {
  opacity: 1;
}
.actions button {
  font-size: 11px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  border-radius: 3px;
  padding: 0 5px;
  cursor: pointer;
}
.actions button:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.body {
  font-family: var(--mono-font);
  font-size: var(--bubble-font-size, 13px);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.hex-line {
  display: flex;
  gap: 12px;
  line-height: 1.5;
}
.off {
  color: var(--text-dim);
}
.hx {
  letter-spacing: 0.5px;
}
.asc {
  color: var(--text-dim);
  white-space: pre;
}
</style>
