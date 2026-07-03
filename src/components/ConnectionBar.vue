<script setup lang="ts">
import { computed, h, nextTick, ref, type VNode, type VNodeChild } from 'vue'
import { NSelect, NButton, NTooltip, NModal, NInput, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useSerialStore } from '@/stores/serial'
import { SCENARIOS } from '@/mock/scenarios'
import { BAUD_NOTES, BAUD_MAX, BAUD_MIN, PRESET_BAUDS, isValidBaud } from '@/utils/baud'
import type { MockScenarioId } from '@/types'

const emit = defineEmits<{
  (e: 'open-ascii'): void
  (e: 'open-settings'): void
}>()

const serial = useSerialStore()
const message = useMessage()

const portOptions = computed(() => serial.ports.map((p) => ({ label: p, value: p })))

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
          title: '编辑标注',
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
          title: '删除该自定义波特率',
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
    message.error('波特率必须为正整数')
    cleanup()
    return
  }
  const n = parseInt(s, 10)
  if (!isValidBaud(n)) {
    message.error(`波特率范围 ${BAUD_MIN} ~ ${BAUD_MAX.toLocaleString()}`)
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
  { label: '7', value: 7 }
]
const stopBitsOptions = [
  { label: '1', value: 1 },
  { label: '2', value: 2 }
]
const parityOptions = [
  { label: 'None', value: 'none' },
  { label: 'Even', value: 'even' },
  { label: 'Odd', value: 'odd' }
]
const scenarioOptions = SCENARIOS.map((s) => ({ label: s.label, value: s.id }))

async function toggle() {
  if (serial.connected) await serial.disconnect()
  else await serial.connect()
}
</script>

<template>
  <div class="bar">
    <NSelect
      v-model:value="serial.selectedPort"
      :options="portOptions"
      size="small"
      placeholder="选择端口"
      style="width: 130px"
      :disabled="serial.connected"
    />
    <NTooltip>
      <template #trigger>
        <NButton size="small" :disabled="serial.connected" @click="serial.refreshPorts()">⟳</NButton>
      </template>
      刷新端口列表
    </NTooltip>

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
      placeholder="波特率"
      :disabled="serial.connected"
      @update:value="onBaudChange"
    />
    <NSelect
      v-model:value="serial.options.dataBits"
      :options="dataBitsOptions"
      size="small"
      style="width: 64px"
      :disabled="serial.connected"
    />
    <NSelect
      v-model:value="serial.options.parity"
      :options="parityOptions"
      size="small"
      style="width: 86px"
      :disabled="serial.connected"
    />
    <NSelect
      v-model:value="serial.options.stopBits"
      :options="stopBitsOptions"
      size="small"
      style="width: 64px"
      :disabled="serial.connected"
    />

    <NButton
      size="small"
      :type="serial.connected ? 'error' : 'primary'"
      strong
      @click="toggle"
    >
      {{ serial.connected ? '断开' : '连接' }}
    </NButton>

    <div class="divider" />

    <span class="mock-label">模拟场景</span>
    <NSelect
      :value="serial.scenario"
      :options="scenarioOptions"
      size="small"
      style="width: 150px"
      @update:value="(v: MockScenarioId) => serial.setScenario(v)"
    />

    <div class="spacer" />

    <NButton size="small" quaternary @click="emit('open-ascii')">ASCII 表</NButton>
    <NButton size="small" quaternary @click="emit('open-settings')">设置</NButton>
  </div>

  <NModal v-model:show="showNoteModal" preset="card" title="编辑标注" style="width: 360px">
    <div class="note-edit">
      <div class="note-baud-line">波特率 <span class="note-baud-num">{{ editingBaud }}</span></div>
      <NInput
        v-model:value="noteDraft"
        placeholder="如：自定义设备、复位波特率（留空清除标注）"
        @keydown.enter="confirmNote"
      />
    </div>
    <template #footer>
      <div class="note-footer">
        <NButton size="small" @click="showNoteModal = false">取消</NButton>
        <NButton size="small" type="primary" @click="confirmNote">保存</NButton>
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
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}
.mock-label {
  font-size: 12px;
  color: var(--text-dim);
}
.spacer {
  flex: 1;
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
