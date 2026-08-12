<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, ref, watch, type VNode, type VNodeChild } from 'vue'
import { NSelect, NButton, NTooltip, NModal, NInput, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useSession, useOccupiedPorts } from '@/composables/useSession'
import { storage } from '@/composables/useStorage'
import { SCENARIOS } from '@/mock/scenarios'
import { BAUD_NOTES, BAUD_MAX, BAUD_MIN, PRESET_BAUDS, isValidBaud } from '@/utils/baud'
import { useI18n } from 'vue-i18n'
import type { MockScenarioId, EndpointInfo, TransportType } from '@/types'

const isDev = import.meta.env.DEV

const { t } = useI18n()

const { serial, recorder } = useSession()
const message = useMessage()

// 悬浮提示统一紧凑样式：更小字体与留白，气泡小一号，避免大块遮挡
const tipStyle = 'font-size:12px;line-height:1.5;padding:4px 8px;max-width:280px'

const occupiedPorts = useOccupiedPorts()

// 传输类型选择：串口 / TCP。TCP 仅 Electron 环境可用（依赖主进程 net 模块）
const tcpAvailable = !!window.electron?.tcp
const transportOptions = computed(() => [
  { label: t('transport.serial'), value: 'serial' as const },
  ...(tcpAvailable ? [{ label: 'TCP', value: 'tcp' as const }] : [])
])

// —— 参数栏收起（默认展开）——
// 收起隐藏端口/波特率等参数控件，腾出数据显示高度；状态按端口持久化，
// 并排多会话各自独立、刷新后保持。收起态保留连接/录制按钮与端口名。
const COLLAPSED_KEY = (port: string) => `connbar:collapsed:${port}`
const collapsed = ref(false)
watch(
  () => serial.selectedPort,
  (port) => { collapsed.value = storage.get(COLLAPSED_KEY(port ?? 'default'), false) },
  { immediate: true }
)
watch(collapsed, (v) => {
  storage.set(COLLAPSED_KEY(serial.selectedPort ?? 'default'), v)
})

const portOptions = computed(() =>
  serial.ports.map((p) => ({
    label: p.path,
    value: p.path,
    // 被其他会话已连接的端口：禁用 + 下拉内红色提示（含当前选中项，防止新会话
    // 自动选中被占用端口后静默连错；本会话已连接时整个下拉本就禁用）
    disabled: occupiedPorts.value.has(p.path)
  }))
)

/** 端口下拉第二行：厂商名 + VID/PID。触发框（selected）只显示路径，元数据降级到菜单项。 */
function formatPortMeta(p: EndpointInfo): string {
  const id = p.vendorId && p.productId ? `VID:${p.vendorId} PID:${p.productId}` : p.vendorId ? `VID:${p.vendorId}` : ''
  return [p.manufacturer, id].filter(Boolean).join(' · ')
}

const renderPortOption: RenderOption = (info) => {
  const path = (info.option as { value: string }).value as string
  const disabled = !!(info.option as { disabled?: boolean }).disabled
  const meta = serial.ports.find((p) => p.path === path)
  const metaText = meta ? formatPortMeta(meta) : ''
  const base = info.node as VNode
  const children = (base.children ? (Array.isArray(base.children) ? base.children : [base.children]) : []) as VNode[]
  const lines = [
    ...children,
    ...(disabled
      ? [h('span', { style: 'color:var(--err);font-size:11px;line-height:1;margin-top:2px' }, t('conn.portOccupied'))]
      : metaText
        ? [h('span', {
            style:
              'color:var(--text-dim);font-size:11px;line-height:1;margin-top:2px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          }, metaText)]
        : [])
  ]
  // render-option 返回的节点会整体替换原 option，丢失其 onClick/onMouseenter 等处理器
  //（select 的选中点击就在这些 props 上）。因此保留原 props 重建同一 div，仅把第二行
  // 追加为子节点并改为纵向布局 —— 整行（含提示/元数据小字）都在可点击区域内。
  const props = base.props as Record<string, unknown> | null
  const origStyle = props && Array.isArray(props.style) ? props.style : props?.style ? [props.style] : []
  return h('div', {
    ...props,
    style: [...origStyle, 'display:flex;flex-direction:column;align-items:flex-start;']
  }, lines)
}

const baudOptions = computed<SelectOption[]>(() => {
  const all = new Set<number>(PRESET_BAUDS)
  for (const c of serial.customBaudRates) all.add(c.baud)
  all.add(serial.options.baudRate) // 当前值始终可选（即便为历史遗留的超范围值）
  return [...all]
    .sort((a, b) => a - b)
    .map((b) => ({ label: String(b), value: b }))
})

/** 自定义项操作按钮（✎ 编辑标注 / × 删除）的统一样式 */
const baudBtnStyle =
  'border:none;background:transparent;cursor:pointer;color:var(--text-dim);font-size:13px;line-height:1;padding:0 4px'

/** render-option 回调签名（等价 NSelect 的 render-option prop，避免深路径 import naive-ui 内部） */
type RenderOption = (info: { option: SelectOption; node: VNode; selected: boolean }) => VNodeChild

/**
 * render-label 同时用于触发器(传 selected=true)与下拉项 content。
 * selected=true 时返回纯数字——触发器框不显示标注；下拉选中项的 content 也为纯数字，
 * 其 ✎/× 按钮改由 render-option 在选项右侧补上(见 renderBaudOption)，故选中项仍可操作。
 */
function renderBaudLabel(option: SelectOption, selected: boolean) {
  if (selected) return option.label as string
  const value = option.value as number
  const note = BAUD_NOTES[value] ?? serial.customBaudRates.find((c) => c.baud === value)?.note
  if (!note) return option.label as string
  return h('span', { style: 'display:inline-flex;align-items:baseline;gap:8px;white-space:nowrap' }, [
    h('span', null, option.label as string),
    h('span', { style: 'color:var(--text-dim);font-size:11px' }, note)
  ])
}

/**
 * render-option 只用于下拉项(触发器不走这里)。在 Naive UI 默认选项节点右侧补上
 * 自定义项的 ✎/×——即便当前选中项(selected)也能编辑标注/删除，不受 render-label
 * 选中态纯数字的影响。按钮 stopPropagation 阻止冒泡到选项 click 选中；预设项无按钮。
 */
const renderBaudOption: RenderOption = (info) => {
  const value = (info.option as { value: string | number }).value as number
  if (!serial.customBaudRates.some((c) => c.baud === value)) return info.node
  const stop = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  }
  const buttons = h(
    'span',
    { style: 'display:inline-flex;align-items:center;flex:none;gap:4px;padding-right:10px' },
    [
      h(
        'button',
        {
          type: 'button',
          title: t('conn.editNoteTooltip'),
          style: baudBtnStyle,
          onMousedown: (e: Event) => e.stopPropagation(),
          onClick: (e: Event) => {
            stop(e)
            openNoteEditor(value)
          }
        },
        '✎'
      ),
      h(
        'button',
        {
          type: 'button',
          title: t('conn.deleteBaud'),
          style: baudBtnStyle,
          onMousedown: (e: Event) => e.stopPropagation(),
          onClick: (e: Event) => {
            stop(e)
            serial.removeCustomBaudRate(value)
          }
        },
        '×'
      )
    ]
  )
  return h('div', { style: 'display:flex;align-items:center;width:100%' }, [
    h('div', { style: 'flex:1;min-width:0' }, [info.node]),
    buttons
  ])
}

/** NSelect 实例 key：用户输入文本后递增以重建组件，清除 tag 模式自动创建的动态 option */
const selectKey = ref(0)

/** 受控变更：校验为正整数且在合理范围，合法则写入并收集为自定义项。
 *  用户直接输入文本时 NSelect 会创建一个字符串动态 option，无论校验是否通过都需
 *  重建 NSelect 把它清掉——否则非法值（如 "100 kama"）会残留下拉且不可选中，
 *  合法值也会与我们的 number option 重复显示。选现有项时 emit 的是 number，无需重建。 */
function onBaudChange(v: number | string) {
  const isTextInput = typeof v === 'string'
  const cleanup = () => {
    if (isTextInput) nextTick(() => selectKey.value++)
  }

  const s = isTextInput ? v.trim() : String(v)
  if (!s) {
    cleanup()
    return
  }
  if (!/^\d+$/.test(s)) {
    message.error(t('conn.baudMustBeInt'))
    cleanup()
    return
  }
  const n = parseInt(s, 10)
  if (!isValidBaud(n)) {
    message.error(`${t('conn.baudRange')} ${BAUD_MIN} ~ ${BAUD_MAX.toLocaleString()}`)
    cleanup()
    return
  }
  serial.options.baudRate = n
  serial.addCustomBaudRate(n)
  cleanup()
}

// —— 自定义波特率标注编辑（下拉项 ✎ 按钮触发）——
const showNoteModal = ref(false)
const editingBaud = ref(0)
const noteDraft = ref('')

function openNoteEditor(baud: number) {
  editingBaud.value = baud
  noteDraft.value = serial.customBaudRates.find((c) => c.baud === baud)?.note ?? ''
  showNoteModal.value = true
}

function confirmNote() {
  serial.updateCustomBaudNote(editingBaud.value, noteDraft.value)
  showNoteModal.value = false
}

const dataBitsOptions = [
  { label: '8', value: 8 },
  { label: '7', value: 7 },
  { label: '6', value: 6 },
  { label: '5', value: 5 }
]
const stopBitsOptions = [
  { label: '1', value: 1 },
  { label: '1.5', value: 1.5 },
  { label: '2', value: 2 }
]
const parityOptions = [
  { label: 'None', value: 'none' },
  { label: 'Even', value: 'even' },
  { label: 'Odd', value: 'odd' }
]
const scenarioOptions = SCENARIOS.map((s) => ({ label: s.label, value: s.id }))

async function toggle() {
  if (serial.connected) await serial.userDisconnect()
  else {
    try {
      await serial.connect()
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('conn.connectFailed'))
    }
  }
}

// 自动重连成功提示一次：reconnecting true→false 且此时已连接，即为重连成功。
// 用户手动连接不走重连路径（reconnecting 一直为 false），不会误触发。
watch(
  () => serial.reconnecting,
  (reconnecting, prev) => {
    if (prev && !reconnecting && serial.connected) {
      message.success(t('conn.reconnected'))
    }
  }
)

async function onRequestPort() {
  try {
    await serial.requestPort()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('conn.connectFailed'))
  }
}

async function startRecording() {
  try {
    await recorder.start()
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

// —— 磁带按钮内部状态 ——
// 状态：录制中/出错用红色，停止中回到灰，闲置灰
const tapeStateClass = computed(() => {
  const s = recorder.state.status
  return {
    recording: s === 'recording',
    error: s === 'error',
    stopping: s === 'stopping'
  }
})

/** 按钮内嵌的录制时长（mm:ss；>1h 切到 h:mm:ss），随 isRecording 启停 1s 定时器。 */
const tapeDuration = ref('')
let tapeTickTimer: ReturnType<typeof setInterval> | null = null
function updateTapeDuration() {
  const started = recorder.state.startedAt
  if (!started) { tapeDuration.value = ''; return }
  const elapsed = Math.floor((Date.now() - started) / 1000)
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const sec = elapsed % 60
  tapeDuration.value = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
watch(() => recorder.isRecording, (rec) => {
  if (rec) {
    updateTapeDuration()
    if (tapeTickTimer) clearInterval(tapeTickTimer)
    tapeTickTimer = setInterval(updateTapeDuration, 1000)
  } else {
    if (tapeTickTimer) { clearInterval(tapeTickTimer); tapeTickTimer = null }
    // stopping 阶段保留最后读数，其余清空
    if (recorder.state.status === 'idle') tapeDuration.value = ''
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (tapeTickTimer) { clearInterval(tapeTickTimer); tapeTickTimer = null }
})
</script>

<template>
  <div class="bar" :class="{ collapsed }">
    <!-- 展开态：完整参数控件 -->
    <template v-if="!collapsed">
      <!-- 传输类型选择器：串口 / TCP（TCP 仅 Electron） -->
      <NSelect
        :value="serial.transportType"
        :options="transportOptions"
        size="small"
        style="width: 88px"
        :disabled="serial.connected"
        @update:value="(v: TransportType) => serial.setTransport(v)"
      />

      <!-- 串口传输：端口/波特率/数据位/校验/停止位 + mock 场景 -->
      <template v-if="serial.transportType === 'serial'">
      <NSelect
        v-model:value="serial.selectedPort"
        :options="portOptions"
        :render-option="renderPortOption"
        :consistent-menu-width="false"
        size="small"
        filterable
        tag
        :placeholder="t('conn.selectPort')"
        style="width: 210px"
        :disabled="serial.connected"
      />
      <NTooltip v-if="serial.driverType === 'webserial'" placement="bottom" :style="tipStyle">
        <template #trigger>
          <NButton size="small" :disabled="serial.connected" @click="onRequestPort">+</NButton>
        </template>
        {{ t('conn.requestPort') }}
      </NTooltip>
      <NTooltip v-if="serial.driverType !== 'webserial'" placement="bottom" :style="tipStyle">
        <template #trigger>
          <NButton size="small" :disabled="serial.connected" @click="serial.refreshPorts()">⟳</NButton>
        </template>
        {{ t('conn.refreshPorts') }}
      </NTooltip>

      <NTooltip placement="bottom" :style="tipStyle">
        <template #trigger>
          <NSelect
            :key="selectKey"
            :value="serial.options.baudRate"
            :options="baudOptions"
            filterable
            tag
            :consistent-menu-width="false"
            :render-label="renderBaudLabel"
            :render-option="renderBaudOption"
            size="small"
            style="width: 120px"
            :placeholder="t('conn.baudRate')"
            :disabled="serial.connected"
            @update:value="onBaudChange"
          />
        </template>
        {{ t('conn.baudTip') }}
      </NTooltip>
      <NTooltip placement="bottom" :style="tipStyle">
        <template #trigger>
          <NSelect
            v-model:value="serial.options.dataBits"
            :options="dataBitsOptions"
            size="small"
            style="width: 64px"
            :disabled="serial.connected"
          />
        </template>
        {{ t('conn.dataBitsTip') }}
      </NTooltip>
      <NTooltip placement="bottom" :style="tipStyle">
        <template #trigger>
          <NSelect
            v-model:value="serial.options.parity"
            :options="parityOptions"
            size="small"
            style="width: 86px"
            :disabled="serial.connected"
          />
        </template>
        {{ t('conn.parityTip') }}
      </NTooltip>
      <NTooltip placement="bottom" :style="tipStyle">
        <template #trigger>
          <NSelect
            v-model:value="serial.options.stopBits"
            :options="stopBitsOptions"
            size="small"
            style="width: 64px"
            :disabled="serial.connected"
          />
        </template>
        {{ t('conn.stopBitsTip') }}
      </NTooltip>

      <template v-if="isDev && serial.driverType === 'mock'">
        <div class="divider" />
        <span class="mock-label">{{ t('conn.mockScene') }}</span>
        <NSelect
          :value="serial.scenario"
          :options="scenarioOptions"
          size="small"
          style="width: 150px"
          @update:value="(v: MockScenarioId) => serial.setScenario(v)"
        />
      </template>
      </template>

      <!-- TCP 传输：主机 + 端口 -->
      <template v-else>
        <NInput
          :value="serial.tcpOptions.host"
          size="small"
          :placeholder="t('transport.tcpHost')"
          style="width: 150px"
          :disabled="serial.connected"
          @update:value="(v: string) => { serial.tcpOptions.host = v }"
        />
        <NInputNumber
          :value="serial.tcpOptions.port"
          :min="1"
          :max="65535"
          size="small"
          style="width: 90px"
          :disabled="serial.connected"
          @update:value="(v: number | null) => { if (v != null) serial.tcpOptions.port = v }"
        />
        <span class="tcp-hint">{{ t('transport.tcpHint') }}</span>
      </template>
    </template>

    <!-- 收起态：紧凑单行——状态点 + 端口名（数据来源可见，栏高收缩让位给数据显示区） -->
    <template v-else>
      <span class="status-dot" :class="{ on: serial.connected, reconnecting: serial.reconnecting }" />
      <span class="port-label">{{ serial.selectedPort ?? t('conn.selectPort') }}</span>
    </template>

    <NButton
      size="small"
      :type="serial.connected ? 'error' : 'primary'"
      strong
      @click="toggle"
    >
      {{ serial.connected ? t('conn.disconnect') : t('conn.connect') }}
    </NButton>

    <!-- 录制控制 -->
    <template v-if="recorder.supported">
      <NTooltip placement="bottom" :style="tipStyle">
        <template #trigger>
          <NButton
            size="small"
            quaternary
            :disabled="recorder.state.status === 'stopping' || (!recorder.isRecording && !recorder.canRecord)"
            @click="recorder.isRecording ? recorder.stop() : startRecording()"
          >
            <span class="rec-pill" :class="tapeStateClass">
              <span class="rec-pill-dot" />
              <span class="rec-pill-label">REC</span>
              <span
                v-if="recorder.isRecording || recorder.state.status === 'stopping'"
                class="rec-pill-duration"
              >{{ tapeDuration }}</span>
            </span>
          </NButton>
        </template>
        {{
          recorder.isRecording
            ? t('record.stop')
            : !recorder.canRecord
              ? t('record.needConfig')
              : t('record.start')
        }}
      </NTooltip>
    </template>

    <div class="spacer" />

    <!-- 参数栏收起/展开 -->
    <NTooltip placement="bottom" :style="tipStyle">
      <template #trigger>
        <NButton size="small" quaternary class="collapse-btn" @click="collapsed = !collapsed">
          {{ collapsed ? '⌄' : '⌃' }}
        </NButton>
      </template>
      {{ collapsed ? t('conn.expandParams') : t('conn.collapseParams') }}
    </NTooltip>
  </div>

  <NModal v-model:show="showNoteModal" preset="card" :title="t('conn.editNoteTitle')" style="width: 360px">
    <div class="note-edit">
      <div class="note-baud-line">{{ t('conn.baudRate') }} <span class="note-baud-num">{{ editingBaud }}</span></div>
      <NInput
        v-model:value="noteDraft"
        :placeholder="t('conn.notePlaceholder')"
        @keydown.enter="confirmNote"
      />
    </div>
    <template #footer>
      <div class="note-footer">
        <NButton size="small" @click="showNoteModal = false">{{ t('conn.cancel') }}</NButton>
        <NButton size="small" type="primary" @click="confirmNote">{{ t('conn.save') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  border-bottom: 1px solid var(--glass-border);
  box-shadow: var(--shadow-sm);
  /* 收起/展开时栏高平滑过渡 */
  transition: padding 0.18s ease;
}
/* 收起态：紧凑单行，栏高收缩让位给数据显示区 */
.bar.collapsed {
  padding: 2px 12px;
}
/* 收起态连接状态点（与会话 tab 圆点一致：灰=未连 / 绿=已连 / 橙=重连中） */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.5;
  flex-shrink: 0;
}
.status-dot.on {
  background: #4caf50;
  opacity: 1;
}
.status-dot.reconnecting {
  background: #ff9800;
  opacity: 1;
}
.divider {
  width: 1px;
  height: 20px;
  background: var(--glass-border);
  margin: 0 4px;
}
.mock-label {
  font-size: 12px;
  color: var(--text-dim);
}
.tcp-hint {
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.85;
}

/* —— REC 胶囊录制按钮 —— */
.rec-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px 0 7px;
  border: 1px solid var(--text-dim);
  border-radius: 999px;
  font-family: var(--mono-font);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  line-height: 1;
  user-select: none;
  transition: color 0.18s, border-color 0.18s, background 0.18s;
}
.rec-pill.recording {
  color: #e04040;
  border-color: #e04040;
  background: rgba(224, 64, 64, 0.08);
}
.rec-pill.error {
  color: #d97706;
  border-color: #d97706;
  background: rgba(217, 119, 6, 0.08);
}
.rec-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.18s, border-color 0.18s;
}
.rec-pill.recording .rec-pill-dot {
  background: currentColor;
  animation: rec-pill-blink 1s ease-in-out infinite;
}
.rec-pill.error .rec-pill-dot {
  background: currentColor;
  animation: none;
}
@keyframes rec-pill-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  .rec-pill.recording .rec-pill-dot {
    animation-duration: 2.4s;
  }
}
.rec-pill-duration {
  font-variant-numeric: tabular-nums;
  padding-left: 4px;
  border-left: 1px solid currentColor;
  opacity: 0.85;
}
.tape-duration {
  margin-left: 6px;
  font-family: var(--mono-font);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #e04040;
  line-height: 1;
  user-select: none;
}
.spacer {
  flex: 1;
}
/* 收起态端口名（参数隐藏后保留数据来源可见性） */
.port-label {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono-font);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}
.collapse-btn {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
  padding: 0 4px;
}
.note-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.note-baud-line {
  font-size: 13px;
  color: var(--text-dim);
}
.note-baud-num {
  font-family: var(--mono-font);
  color: var(--text);
  margin-left: 4px;
}
.note-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
