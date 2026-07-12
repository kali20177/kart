<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { DataMode, Encoding, Message } from '@/types'
import { bytesToHex, hexDump } from '@/utils/hex'
import { decodeBytes } from '@/utils/encoding'
import { formatMessageLine, formatTimestamp } from '@/utils/message-format'
import FileTransferBubble from './FileTransferBubble.vue'

interface Range {
  start: number
  end: number
}

const props = defineProps<{
  message: Message
  viewMode: DataMode
  encoding: Encoding
  /** 多选模式：显示勾选圈、左键切换选中、隐藏单条操作按钮 */
  selectable?: boolean
  selected?: boolean
  /** 搜索关键字（不为空且命中时渲染高亮） */
  keyword?: string
  /** 搜索模式：text=字符偏移，hex=字节偏移 */
  searchMode?: 'text' | 'hex'
  /** 命中区间（文本模式=字符偏移、HEX 模式=字节偏移；文本模式已合并相交区间） */
  matchRanges?: Range[]
  /** 当前为导航目标帧（命中用活动色 + 短暂 flash） */
  activeMatch?: boolean
}>()

const emit = defineEmits<{
  (e: 'resend', bytes: Uint8Array): void
  (e: 'select'): void
  (e: 'contextmenu', ev: MouseEvent): void
}>()

const { t } = useI18n()
const toast = useMessage()

const isTx = computed(() => props.message.direction === 'tx')

const timeLabel = computed(() => formatTimestamp(props.message.timestamp, 'short'))

const asciiText = computed(() => decodeBytes(props.message.bytes, props.encoding))
const dumpLines = computed(() => hexDump(props.message.bytes, 16))

const isSearching = computed(() => !!props.keyword?.trim() && (props.matchRanges?.length ?? 0) > 0)

// 原生配对才内联高亮：text+ascii / hex+hex。
// 交叉配对（如 hex 搜索 + ascii 视图）字节偏移≠字符偏移，强渲会错位；
// 此时仍过滤 / 导航 / flash，只是不做逐字高亮（见 plan 取舍说明）。
const hlAscii = computed(
  () => props.viewMode === 'ascii' && props.searchMode === 'text' && isSearching.value
)
const hlHex = computed(
  () => props.viewMode === 'hex' && props.searchMode === 'hex' && isSearching.value
)

/** ASCII 高亮片段：按（已合并的）字符区间切分 */
const highlightedAscii = computed(() => {
  const text = asciiText.value
  const ranges = props.matchRanges
  if (!hlAscii.value || !ranges) return [{ text, hl: false }]
  const parts: Array<{ text: string; hl: boolean }> = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) parts.push({ text: text.slice(cursor, r.start), hl: false })
    parts.push({ text: text.slice(r.start, r.end), hl: true })
    cursor = r.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hl: false })
  return parts
})

/** HEX 高亮：从原始字节重建逐字节视图，命中字节（Set 天然去重）加 hl */
interface HighlightedByte {
  hex: string
  ascii: string
  hl: boolean
}
interface HighlightedHexLine {
  offset: string
  bytes: HighlightedByte[]
}
const BYTES_PER_LINE = 16
const highlightedDumpLines = computed<HighlightedHexLine[]>(() => {
  const bytes = props.message.bytes
  const ranges = props.matchRanges
  const hl = hlHex.value && ranges
  const hlSet = new Set<number>()
  if (hl) {
    for (const r of ranges!) {
      for (let i = r.start; i < r.end; i++) hlSet.add(i)
    }
  }
  const lines: HighlightedHexLine[] = []
  for (let off = 0; off < bytes.length; off += BYTES_PER_LINE) {
    const offsetStr = off.toString(16).padStart(4, '0').toUpperCase()
    const lineBytes: HighlightedByte[] = []
    for (let i = 0; i < BYTES_PER_LINE; i++) {
      const byteIndex = off + i
      if (byteIndex < bytes.length) {
        const b = bytes[byteIndex]
        lineBytes.push({
          hex: b.toString(16).padStart(2, '0').toUpperCase(),
          ascii: b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.',
          hl: hl ? hlSet.has(byteIndex) : false
        })
      } else {
        lineBytes.push({ hex: '  ', ascii: ' ', hl: false })
      }
    }
    lines.push({ offset: offsetStr, bytes: lineBytes })
  }
  return lines
})

/** 高亮 class：活动帧用活动色，其余命中用普通高亮色 */
function hlClass(on: boolean): string | undefined {
  if (!on) return undefined
  return props.activeMatch ? 'hl-active' : 'hl'
}

// flash：activeMatch 变 true 时短暂闪烁；用 onCleanup 清理定时器，避免快速导航时泄漏
const flash = ref(false)
watchEffect((onCleanup) => {
  if (props.activeMatch) {
    flash.value = true
    const id = setTimeout(() => {
      flash.value = false
    }, 600)
    onCleanup(() => clearTimeout(id))
  } else {
    flash.value = false
  }
})

/** 复制本帧：带时间戳 + 方向前缀，与气泡显示时间一致 */
function copyCurrent() {
  navigator.clipboard?.writeText(
    formatMessageLine(props.message, {
      viewMode: props.viewMode,
      encoding: props.encoding,
      timeStyle: 'short'
    })
  )
  toast.success(t('bubble.coped'))
}

/** 复制为纯 HEX（不带前缀，喂脚本 / 编辑器用） */
function copyHex() {
  navigator.clipboard?.writeText(bytesToHex(props.message.bytes))
  toast.success(t('bubble.coped'))
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
    :class="[isTx ? 'row-tx' : 'row-rx', message.kind === 'divider' ? 'row-divider' : '', { selectable, selected, flash }]"
    @click="onRowClick"
    @contextmenu="onRowContext"
  >
    <span v-if="selectable" class="check" :class="{ checked: selected }">{{ selected ? '✓' : '' }}</span>
    <!-- 分隔线：不套 bubble 容器 -->
    <div v-if="message.kind === 'divider'" class="divider">
      <div class="divider-line" />
      <span v-if="message.note" class="divider-label">{{ message.note }}</span>
      <div class="divider-line" />
      <span class="divider-time">{{ timeLabel }}</span>
    </div>
    <!-- 文件下发／普通帧：套 bubble 容器 -->
    <div v-else class="bubble" :class="isTx ? 'bubble-tx' : 'bubble-rx'">
      <!-- 文件下发气泡：委托给 FileTransferBubble -->
      <FileTransferBubble
        v-if="message.kind === 'file' && message.transferId"
        :transfer-id="message.transferId"
        :timestamp="message.timestamp"
      />
      <!-- 普通帧气泡 -->
      <template v-else>
        <div class="meta">
        <span class="dir">{{ isTx ? 'TX ▸' : '◂ RX' }}</span>
        <span class="time">{{ timeLabel }}</span>
        <span class="len">{{ message.bytes.length }} B</span>
        <span class="mode-badge">{{ viewMode === 'hex' ? 'HEX' : 'ASCII' }}</span>
        <span v-if="message.error" class="err-badge">⚠ {{ message.error }}</span>
        <span class="spacer" />
        <span v-if="!selectable" class="actions">
          <button :title="t('bubble.copyFrame')" @click="copyCurrent">{{ t('bubble.copy') }}</button>
          <button :title="t('bubble.copyHex')" @click="copyHex">Hex</button>
          <button v-if="isTx" :title="t('bubble.resend')" @click="emit('resend', message.bytes)">{{ t('bubble.resend') }}</button>
        </span>
      </div>

      <!-- ASCII 视图：无高亮 -->
      <pre v-if="viewMode === 'ascii' && !hlAscii" class="body ascii">{{ asciiText }}</pre>
      <!-- ASCII 视图：文本高亮 -->
      <pre v-else-if="viewMode === 'ascii'" class="body ascii"
        ><mark
          v-for="(part, pi) in highlightedAscii"
          :key="pi"
          :class="hlClass(part.hl)"
          >{{ part.text }}</mark
        ></pre
      >

      <!-- HEX 视图：无高亮（默认） -->
      <div v-if="viewMode !== 'ascii' && !hlHex" class="body hex">
        <div v-for="(line, i) in dumpLines" :key="i" class="hex-line">
          <span class="off">{{ line.offset }}</span>
          <span class="hx">{{ line.hex }}</span>
          <span class="asc">{{ line.ascii }}</span>
        </div>
      </div>
      <!-- HEX 视图：字节高亮 -->
      <div v-else-if="viewMode !== 'ascii'" class="body hex">
        <div v-for="(line, i) in highlightedDumpLines" :key="i" class="hex-line">
          <span class="off">{{ line.offset }}</span>
          <span class="hx">
            <span
              v-for="(b, bi) in line.bytes"
              :key="bi"
              :class="hlClass(b.hl)"
              >{{ b.hex }}{{ bi < line.bytes.length - 1 ? ' ' : '' }}</span
            >
          </span>
          <span class="asc">
            <span v-for="(b, bi) in line.bytes" :key="bi" :class="hlClass(b.hl)">{{ b.ascii }}</span>
          </span>
        </div>
      </div>

      <!-- 用户标注 -->
      <div v-if="message.note" class="note-bar">
        <span class="note-icon">📌</span>
        <span class="note-text">{{ message.note }}</span>
      </div>
      </template>
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
.row-divider {
  justify-content: center;
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
  box-shadow: 0 0 0 1px var(--accent), var(--shadow-sm);
}
.bubble {
  max-width: 78%;
  border: 1px solid;
  padding: 5px 9px 7px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.bubble-rx {
  background: var(--rx-bg);
  border-color: var(--rx-border);
  color: var(--rx-text);
  border-radius: 0 var(--radius) var(--radius) var(--radius);
}
.bubble-tx {
  background: var(--tx-bg);
  border-color: var(--tx-border);
  color: var(--tx-text);
  border-radius: var(--radius) 0 var(--radius) var(--radius);
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
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
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
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  color: var(--text-dim);
  border-radius: var(--radius-sm);
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

/* 分隔线样式 */
.divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  width: 100%;
}
.divider-line {
  flex: 1;
  height: 1px;
  background: var(--glass-border);
}
.divider-label {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  padding: 0 4px;
}
.divider-time {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}

/* 用户标注条 */
.note-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--glass-border);
}
.note-icon {
  flex: none;
  font-size: 12px;
  line-height: 1;
}
.note-text {
  font-size: 11px;
  color: var(--accent-cyan);
  line-height: 1.3;
  word-break: break-all;
}


/* 搜索高亮：mark 默认黄底重置为透明，仅 .hl / .hl-active 着色 */
mark {
  background: none;
  color: inherit;
}
.hl {
  background: var(--search-highlight-bg);
  color: var(--search-highlight-text);
  border-radius: 2px;
}
.hl-active {
  background: var(--search-active-bg);
  color: var(--search-active-text);
  border-radius: 2px;
}

/* 导航目标帧 flash */
.row.flash .bubble {
  animation: search-flash 0.6s ease-out;
}
@keyframes search-flash {
  0% {
    box-shadow: 0 0 0 2px var(--search-active-bg);
  }
  100% {
    box-shadow: 0 0 0 2px transparent;
  }
}
</style>
