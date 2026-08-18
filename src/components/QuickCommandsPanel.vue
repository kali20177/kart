<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import {
  NButton,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NColorPicker,
  NDropdown,
  useMessage
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useActiveSession } from '@/composables/useSession'
import { useCommandsStore } from '@/stores/commands'
import { useSendHistory } from '@/composables/useSendHistory'
import { expandCommandVars } from '@/utils/command-vars'
import type { DataMode, LineEnding, QuickCommand } from '@/types'

const sendHistory = useSendHistory()

const emit = defineEmits<{
  (e: 'to-composer', payload: { text: string; mode: DataMode }): void
}>()

const store = useCommandsStore()
// useActiveSession 返回活动会话 ref，用 computed 派生 serial/checksum：切 tab 时
// 快速命令从当前活动 tab 的串口发出，校验继承该会话的默认发送校验（会话级）。
const activeSession = useActiveSession()
const serial = computed(() => activeSession.value.serial)
const checksum = computed(() => activeSession.value.checksum)
const message = useMessage()
const { t } = useI18n()

// ── 每命令独立循环发送状态（组件级：面板常驻 App 根，v-show 隐藏不影响循环）──
const looping = ref<Set<string>>(new Set())
const loopTimers = new Map<string, ReturnType<typeof setInterval>>()
const loopSent = new Map<string, number>()
const loopUnwatches = new Map<string, () => void>()

type LoopStopReason = 'manual' | 'completed' | 'disconnect' | 'silent'

const modeOptions = [
  { label: 'ASCII', value: 'ascii' },
  { label: 'HEX', value: 'hex' }
]
const endingOptions = [
  { label: t('commands.inherit'), value: 'inherit' },
  { label: t('composer.none'), value: 'none' },
  { label: '\\r', value: 'cr' },
  { label: '\\n', value: 'lf' },
  { label: '\\r\\n', value: 'crlf' }
]
const checksumOptions = computed(() => [
  { label: t('checksum.inheritDefault'), value: 'inherit' },
  { label: t('checksum.algo.none'), value: 'none' },
  { label: t('checksum.algo.sum8'), value: 'sum8' },
  { label: t('checksum.algo.xor8'), value: 'xor8' },
  { label: t('checksum.algo.crc16-modbus'), value: 'crc16-modbus' },
  { label: t('checksum.algo.crc32'), value: 'crc32' }
])

// 编辑弹窗
const showEdit = ref(false)
const editing = ref<QuickCommand>(blank())
const isNew = ref(true)

function blank(): QuickCommand {
  return {
    id: '',
    name: '',
    payload: '',
    mode: 'ascii',
    appendNewline: 'crlf',
    color: '#2080f0',
    checksum: 'inherit',
    loopIntervalMs: 1000,
    loopCount: 0
  }
}

function openNew() {
  editing.value = blank()
  isNew.value = true
  showEdit.value = true
}
function openEdit(c: QuickCommand) {
  editing.value = { ...c }
  isNew.value = false
  showEdit.value = true
}
function saveEdit() {
  if (!editing.value.name.trim()) {
    message.warning(t('commands.needName'))
    return
  }
  if (isNew.value) {
    const { id: _id, ...rest } = editing.value
    void _id
    store.add(rest)
  } else {
    store.update(editing.value.id, editing.value)
  }
  showEdit.value = false
}

/**
 * 展开占位符后发送一次。
 * c 为模板（保留占位符），s/cfg 为发送目标——单发用当前活动会话，
 * 循环在启动时捕获会话快照，避免切 tab 后把命令发到别的会话。
 * 校验和在该会话默认发送校验（cs 解析后）之上计算，覆盖有的展开后内容，天然联动。
 */
async function runOnce(c: QuickCommand, s: typeof serial.value, cfg: typeof checksum.value): Promise<boolean> {
  const payload = expandCommandVars(c.payload, c.mode, { seq: store.nextSeq(c.id) })
  const ending: LineEnding = c.appendNewline === 'inherit' ? 'crlf' : c.appendNewline
  const cs = !c.checksum || c.checksum === 'inherit' ? cfg.send : c.checksum
  try {
    const r = await s.send(payload, c.mode, ending, 'utf-8', cs)
    if (!r.ok) {
      message.error(r.error ?? t('commands.sendFailed'))
      return false
    }
    return true
  } catch (e) {
    // 防御：serial.send 内部已捕获驱动异常返回 {ok:false}；此处兜底实现变化，
    // 防止 setInterval 回调产生 unhandled rejection 且循环不收敛。
    message.error(e instanceof Error ? e.message : String(e))
    return false
  }
}

async function sendCmd(c: QuickCommand) {
  // 循环中点击卡片 = 停止该命令的循环（与发送框「发送/停止」按钮一致的语义）
  if (looping.value.has(c.id)) {
    stopLoop(c.id, 'manual')
    return
  }
  const ok = await runOnce(c, serial.value, checksum.value)
  // 记录模板本身（含占位符），回填发送框后仍可编辑动态值
  if (ok) sendHistory.add(c.payload)
}

function startLoop(c: QuickCommand) {
  if (!serial.value.connected) {
    message.warning(t('composer.needConnect'))
    return
  }
  // 快照循环目标的会话与会话校验：切 tab 不影响本次循环；
  // 校验取值拷贝而非引用，循环运行中在面板外修改会话校验也不串改
  const s = serial.value
  const cfg = { ...checksum.value }
  const interval = Math.max(10, c.loopIntervalMs ?? 1000)
  const total = c.loopCount ?? 0
  looping.value.add(c.id)
  loopSent.set(c.id, 0)
  message.info(
    total > 0
      ? t('composer.loopStartCount', { total, interval })
      : t('composer.loopStartInfinite', { interval }),
    { duration: 2000 }
  )
  loopTimers.set(
    c.id,
    setInterval(async () => {
      const ok = await runOnce(c, s, cfg)
      if (!ok) {
        stopLoop(c.id, 'silent') // runOnce 已弹错误提示，这里静默停
        return
      }
      const n = (loopSent.get(c.id) ?? 0) + 1
      loopSent.set(c.id, n)
      if (total > 0 && n >= total) stopLoop(c.id, 'completed')
    }, interval)
  )
  // 目标会话断连即停（发失败才停会多等一个间隔）
  loopUnwatches.set(
    c.id,
    watch(() => s.connected, (on) => { if (!on) stopLoop(c.id, 'disconnect') })
  )
}

function stopLoop(id: string, reason: LoopStopReason) {
  const timer = loopTimers.get(id)
  if (timer) {
    clearInterval(timer)
    loopTimers.delete(id)
  }
  loopUnwatches.get(id)?.()
  loopUnwatches.delete(id)
  if (!looping.value.has(id)) return
  looping.value.delete(id)
  const n = loopSent.get(id) ?? 0
  loopSent.delete(id)
  if (reason === 'completed') {
    message.success(t('composer.loopDone', { n }), { duration: 3000 })
  } else if (reason === 'manual') {
    message.info(t('composer.loopStopped', { n }), { duration: 2000 })
  } else if (reason === 'disconnect') {
    message.warning(t('composer.loopDisconnect', { n }), { duration: 3000 })
  }
  // silent: 不提示（卸载、或发送错误已自行弹窗）
}

function toggleLoop(c: QuickCommand) {
  if (looping.value.has(c.id)) stopLoop(c.id, 'manual')
  else startLoop(c)
}

function menuOptions(c: QuickCommand) {
  return [
    { label: t('commands.edit'), key: 'edit' },
    { label: t('commands.toComposer'), key: 'to-composer' },
    { label: t('commands.duplicate'), key: 'dup' },
    { label: t('commands.delete'), key: 'del' }
  ].map((o) => ({ ...o, cmd: c }))
}
function onMenu(key: string, c: QuickCommand) {
  if (key === 'edit') {
    // 编辑会替换 store 条目，循环闭包持有旧对象——先停再编辑，避免发旧配置
    if (looping.value.has(c.id)) stopLoop(c.id, 'silent')
    openEdit(c)
  } else if (key === 'dup') {
    store.duplicate(c.id)
  } else if (key === 'del') {
    if (looping.value.has(c.id)) stopLoop(c.id, 'silent')
    store.remove(c.id)
  } else if (key === 'to-composer') emit('to-composer', { text: c.payload, mode: c.mode })
}

// 命令列表被整体替换（导入 importJson / 恢复默认 resetToPresets）时，被循环的
// 旧 id 命令会从列表消失但定时器仍残留——监听 id 集合，消失即停，一处覆盖所有替换路径
// （拖拽排序只改顺序不改集合，不会误停）。
watch(
  () => store.commands.map((c) => c.id).join(','),
  (ids) => {
    if (!looping.value.size) return
    for (const id of [...looping.value]) {
      if (!ids.includes(id)) stopLoop(id, 'silent')
    }
  }
)

// 面板卸载兜底：停止所有残留循环
onBeforeUnmount(() => {
  for (const id of [...looping.value]) stopLoop(id, 'silent')
})

// 拖拽排序
const dragIndex = ref<number | null>(null)
function onDrop(to: number) {
  if (dragIndex.value != null) store.move(dragIndex.value, to)
  dragIndex.value = null
}

// 导入导出
async function doExport() {
  const content = store.exportJson()
  if (window.kart?.saveTextFile) {
    await window.kart.saveTextFile(content, 'quick-commands.json')
    return
  }
  const blob = new Blob([content], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'quick-commands.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
const fileInput = ref<HTMLInputElement | null>(null)
function doImportClick() {
  fileInput.value?.click()
}
function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    // 列表整体替换后，旧 id 循环由上方 id 集合 watch 统一停掉（导入失败时列表未变，循环保留）
    const r = store.importJson(String(reader.result))
    if (r.ok) message.success(t('commands.importOk'))
    else message.error(r.error ?? t('commands.importFail'))
  }
  reader.readAsText(f)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="panel">
    <div class="head">
      <span class="title">{{ t('commands.title') }}</span>
      <div class="head-actions">
        <button type="button" class="icon-btn" :aria-label="t('commands.import')" @click="doImportClick">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 13.5h12" />
            <path d="M8 3v8" />
            <path d="M4.5 7.5 8 11l3.5-3.5" />
          </svg>
        </button>
        <button type="button" class="icon-btn" :aria-label="t('commands.export')" @click="doExport">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 13.5h12" />
            <path d="M8 11V3" />
            <path d="M4.5 6.5 8 3l3.5 3.5" />
          </svg>
        </button>
      </div>
    </div>

    <input ref="fileInput" type="file" accept="application/json" hidden @change="onFile" />

    <div class="list">
      <button type="button" class="add-card" :aria-label="t('commands.newCmd')" @click="openNew">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <div
        v-for="(c, i) in store.commands"
        :key="c.id"
        class="item"
        :class="{ 'is-looping': looping.has(c.id) }"
        draggable="true"
        @dragstart="dragIndex = i"
        @dragover.prevent
        @drop="onDrop(i)"
      >
        <span class="dot" :style="{ background: c.color || 'var(--accent)' }" />
        <div class="info" @click="sendCmd(c)">
          <div class="name">{{ c.name }}</div>
          <div class="payload">
            <span class="tag">{{ c.mode.toUpperCase() }}</span>{{ c.payload }}
          </div>
        </div>
        <button
          type="button"
          class="icon-btn loop-btn"
          :class="{ active: looping.has(c.id) }"
          :title="looping.has(c.id) ? t('commands.loopStop') : t('commands.loop')"
          @click="toggleLoop(c)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 8a5 5 0 0 1-9 3M3 8a5 5 0 0 1 9-3" />
            <path d="M13 3v3h-3M3 13v-3h3" />
          </svg>
        </button>
        <NDropdown
          trigger="click"
          :options="menuOptions(c)"
          @select="(key: string) => onMenu(key, c)"
        >
          <NButton size="tiny" quaternary>⋯</NButton>
        </NDropdown>
      </div>
      <div v-if="store.commands.length === 0" class="empty">{{ t('commands.empty') }}</div>
    </div>

    <NModal
      v-model:show="showEdit"
      preset="card"
      :title="isNew ? t('commands.newCmd') : t('commands.editCmd')"
      style="width: 420px"
    >
      <NForm label-placement="left" label-width="72">
        <NFormItem :label="t('commands.name')">
          <NInput v-model:value="editing.name" :placeholder="t('commands.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('commands.content')">
          <NInput v-model:value="editing.payload" :placeholder="t('commands.payloadPlaceholder')" />
          <div class="hint">{{ t('commands.payloadHint') }}: <code>{time} {time:full} {seq} {rand}</code></div>
        </NFormItem>
        <NFormItem :label="t('commands.mode')">
          <NSelect v-model:value="editing.mode" :options="modeOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.lineEnding')">
          <NSelect v-model:value="editing.appendNewline" :options="endingOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.checksum')">
          <NSelect v-model:value="editing.checksum" :options="checksumOptions" />
        </NFormItem>
        <NFormItem :label="t('commands.loop')">
          <div style="display: flex; align-items: center; gap: 8px">
            <NInputNumber v-model:value="editing.loopIntervalMs" :min="10" :step="100" size="small" style="width: 130px">
              <template #suffix>ms</template>
            </NInputNumber>
            <NInputNumber v-model:value="editing.loopCount" :min="0" size="small" style="width: 120px">
              <template #suffix>{{ t('commands.loopCount') }}</template>
            </NInputNumber>
          </div>
        </NFormItem>
        <NFormItem :label="t('commands.color')">
          <NColorPicker v-model:value="editing.color" :show-alpha="false" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <NButton @click="showEdit = false">{{ t('commands.cancel') }}</NButton>
          <NButton type="primary" @click="saveEdit">{{ t('commands.save') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--glass-border);
}
.title {
  font-weight: 600;
  font-size: 13px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.icon-btn svg {
  width: 14px;
  height: 14px;
}
.hint {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
  line-height: 1.5;
}
.hint code {
  font-family: var(--mono-font);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-sm);
  padding: 0 4px;
}
.loop-btn.active {
  color: var(--accent);
  animation: loop-pulse 1.2s ease-out infinite;
}
.item.is-looping .name {
  color: var(--accent);
}
@keyframes loop-pulse {
  0%   { opacity: 1; transform: scale(1); }
  50%  { opacity: 0.5; transform: scale(0.9); }
  100% { opacity: 1; transform: scale(1); }
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.add-card {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 38px;
  margin-bottom: 6px;
  border: 1px dashed var(--glass-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.add-card:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.04);
}
.add-card svg {
  width: 18px;
  height: 18px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius);
  cursor: grab;
}
.item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.name {
  font-size: 13px;
}
.payload {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono-font);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  display: inline-block;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: 0 3px;
  margin-right: 5px;
  font-size: 10px;
}
.empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 24px 0;
}
</style>
