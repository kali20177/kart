<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect } from 'naive-ui'
import { useSession } from '@/composables/useSession'
import { listDecoders } from '@/decoders'
import { fieldStatus, type DashboardWidget, type DashboardWidgetType } from '@/stores/dashboard'

/**
 * 仪表盘视图：把帧解码字段实时呈现为 widget 卡片网格（数字表 / 状态灯 / 字段总览表）。
 * 数据源 = 解码器字段（messages.onDecode 广播 → dashboard store 最新值表），
 * 卡片按 version 信号刷新；widget 配置由 session 按端口持久化。
 * 卡片支持 HTML5 拖拽排序；右上角 + 打开配置弹窗；消息气泡字段 chip 右键也可添加。
 */

/** dockview 面板内容组件 props：params 内携带面板 api（激活状态/事件）。 */
interface DashboardPanelParams {
  params?: unknown
  api: {
    isActive: boolean
    onDidActiveChange: (cb: (e: { isActive: boolean }) => void) => { dispose(): void }
  }
  containerApi: unknown
  tabLocation: string
}

const props = defineProps<{ params: DashboardPanelParams }>()
// 面板是否激活（dockview）：不激活时暂停刷新（同 WaveformChart 模式）
const isActive = ref(props.params.api.isActive)
props.params.api.onDidActiveChange((e) => {
  isActive.value = e.isActive
})

const { dashboard, decoder } = useSession()
const { t } = useI18n()

// —— widget 列表（session.dashboard 经 reactive 解包，widgets 即数组） ——
const widgets = computed(() => dashboard.widgets)

/** 读取 widget 绑定的最新快照（值/显示/时间戳），无快照 → undefined */
function snapOf(w: DashboardWidget) {
  return dashboard.widgetSnapshot(w)
}

/** 状态色 class：alarm / warn / normal（无绑定值 → 中性） */
function statusClass(w: DashboardWidget): string {
  const snap = snapOf(w)
  if (!snap) return ''
  return fieldStatus(w, snap.value)
}

/** 数字表显示值：有数值按小数位格式化；无数值回退显示原始串；无快照显示占位 */
function displayValue(w: DashboardWidget): string {
  const snap = snapOf(w)
  if (!snap) return '—'
  if (snap.value !== undefined) {
    const d = w.decimals ?? 0
    return snap.value.toFixed(Math.max(0, Math.min(d, 6)))
  }
  return snap.display
}

/** 更新时间：HH:MM:SS.mmm（无快照 → 空） */
function updatedText(w: DashboardWidget): string {
  const snap = snapOf(w)
  if (!snap) return ''
  const d = new Date(snap.timestamp)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function statusLabel(w: DashboardWidget): string {
  const st = statusClass(w)
  if (st === 'alarm') return t('dashboard.statusAlarm')
  if (st === 'warn') return t('dashboard.statusWarn')
  return t('dashboard.statusNormal')
}

/** 阈值范围文本（数字表卡片底部的「≤85 · ≥5」提示） */
function thresholdText(w: DashboardWidget): string {
  const parts: string[] = []
  if (w.thresholdLow !== undefined) parts.push(`≥${w.thresholdLow}`)
  if (w.thresholdHigh !== undefined) parts.push(`≤${w.thresholdHigh}`)
  return parts.join(' · ')
}

// —— 字段总览表（最近一帧完整解码字段） ——
const frameFields = computed(() => dashboard.lastFrame?.fields ?? [])

// —— 拖拽排序（原生 HTML5 draggable） ——
let dragIndex: number | null = null
function onDragStart(i: number) {
  dragIndex = i
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
}
function onDrop(i: number) {
  if (dragIndex !== null && dragIndex !== i) dashboard.moveWidget(dragIndex, i)
  dragIndex = null
}
function onDragEnd() {
  dragIndex = null
}

// —— 配置弹窗（添加 / 编辑 widget） ——
const showConfig = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  type: 'digital' as DashboardWidgetType,
  label: '',
  decoderId: 'field',
  fieldName: '',
  index: null as number | null,
  unit: '',
  thresholdLow: null as number | null,
  thresholdHigh: null as number | null,
  decimals: 0,
})

const typeOptions = [
  { label: t('dashboard.digital'), value: 'digital' },
  { label: t('dashboard.led'), value: 'led' },
  { label: t('dashboard.fieldTable'), value: 'field-table' },
]

const decoderOptions = listDecoders().map((d) => ({ label: d.name, value: d.id }))

/** 字段名候选项：最近一帧解码字段名（filterable+tag 允许手动输入任意字段名） */
const fieldOptions = computed(() => {
  const names = new Set<string>()
  for (const f of frameFields.value) names.add(f.name)
  // 字段布局解码器配置中的字段名也是合法候选（可能尚未有数据帧）
  if (decoder.id === 'field') {
    const fields = (decoder.options as { fields?: { name: string }[] }).fields
    for (const f of fields ?? []) if (f?.name) names.add(f.name)
  }
  return [...names].map((n) => ({ label: n, value: n }))
})

/** 当前表单类型是否绑定数据源（字段总览表无需绑定） */
const needsBind = computed(() => form.type !== 'field-table')

const bindValid = computed(
  () => form.label.trim() !== '' && (!needsBind.value || (form.decoderId !== '' && form.fieldName.trim() !== ''))
)

function openCreate() {
  editingId.value = null
  Object.assign(form, {
    type: 'digital' as DashboardWidgetType,
    label: '',
    decoderId: 'field',
    fieldName: '',
    index: null,
    unit: '',
    thresholdLow: null,
    thresholdHigh: null,
    decimals: 0,
  })
  showConfig.value = true
}

function openEdit(w: DashboardWidget) {
  editingId.value = w.id
  Object.assign(form, {
    type: w.type,
    label: w.label,
    decoderId: w.bind?.decoderId ?? 'field',
    fieldName: w.bind?.fieldName ?? '',
    index: w.bind?.index ?? null,
    unit: w.unit ?? '',
    thresholdLow: w.thresholdLow ?? null,
    thresholdHigh: w.thresholdHigh ?? null,
    decimals: w.decimals ?? 0,
  })
  showConfig.value = true
}

function saveWidget() {
  if (!bindValid.value) return
  const base = {
    type: form.type,
    label: form.label.trim(),
    unit: form.unit.trim() || undefined,
    thresholdLow: form.thresholdLow ?? undefined,
    thresholdHigh: form.thresholdHigh ?? undefined,
    decimals: form.decimals,
    ...(needsBind.value
      ? { bind: { decoderId: form.decoderId, fieldName: form.fieldName.trim(), ...(form.index !== null ? { index: form.index } : {}) } as DashboardWidget['bind'] }
      : {}),
  }
  if (editingId.value) {
    dashboard.updateWidget(editingId.value, base)
  } else {
    dashboard.addWidget(base)
  }
  showConfig.value = false
}
</script>

<template>
  <div class="dashboard-pane" :data-ver="dashboard.version">
    <div class="dash-toolbar">
      <span class="dash-title">{{ t('dashboard.panel') }}</span>
      <button class="dash-add" :title="t('dashboard.addWidget')" @click="openCreate">＋</button>
    </div>

    <!-- 卡片网格（field-table 卡片通栏） -->
    <div v-if="widgets.length > 0" class="dash-grid" :class="{ paused: !isActive }">
      <div
        v-for="(w, i) in widgets"
        :key="w.id"
        class="dash-card"
        :class="[`type-${w.type}`, statusClass(w)]"
        :data-dash-id="w.id"
        draggable="true"
        @dragstart="onDragStart(i)"
        @dragover="onDragOver"
        @drop="onDrop(i)"
        @dragend="onDragEnd"
      >
        <div class="dash-card-head">
          <span class="dash-card-label" :title="w.label">{{ w.label }}</span>
          <div class="dash-card-actions">
            <button class="dash-act" :title="t('dashboard.edit')" @click.stop="openEdit(w)">⚙</button>
            <button class="dash-act" :title="t('dashboard.remove')" @click.stop="dashboard.removeWidget(w.id)">×</button>
          </div>
        </div>

        <!-- 数字表 -->
        <template v-if="w.type === 'digital'">
          <div class="dash-digital">
            <div class="dash-value">{{ displayValue(w) }}</div>
            <div class="dash-meta">
              <span class="dash-unit">{{ w.unit }}</span>
              <span class="dash-status" :class="statusClass(w)">{{ statusLabel(w) }}</span>
            </div>
          </div>
          <div class="dash-foot">
            <span class="dash-threshold" v-if="w.thresholdLow !== undefined || w.thresholdHigh !== undefined">
              {{ thresholdText(w) }}
            </span>
            <span class="dash-updated">{{ updatedText(w) }}</span>
          </div>
        </template>

        <!-- 状态灯 -->
        <template v-else-if="w.type === 'led'">
          <div class="dash-led">
            <span class="led-dot" :class="statusClass(w) || 'off'" />
            <span class="led-text">{{ statusLabel(w) }}</span>
          </div>
          <div class="dash-foot">
            <span class="dash-updated">{{ updatedText(w) }}</span>
          </div>
        </template>

        <!-- 字段总览表（通栏） -->
        <template v-else>
          <div v-if="frameFields.length > 0" class="dash-table">
            <div v-for="(f, fi) in frameFields" :key="fi" class="dash-table-row">
              <span class="dash-table-name" :title="`${f.name} @ ${f.offset}+${f.length}`">{{ f.name }}</span>
              <span class="dash-table-value">{{ f.value }}</span>
            </div>
          </div>
          <div v-else class="dash-nodata">{{ t('dashboard.noData') }}</div>
        </template>
      </div>
    </div>

    <!-- 空态引导 -->
    <div v-else class="dash-empty">
      <p class="dash-empty-title">{{ t('dashboard.emptyTitle') }}</p>
      <p class="dash-empty-hint">{{ t('dashboard.emptyHint') }}</p>
      <NButton size="small" secondary type="primary" @click="openCreate">{{ t('dashboard.addWidget') }}</NButton>
    </div>

    <!-- 配置弹窗 -->
    <NModal v-model:show="showConfig" preset="card" :title="editingId ? t('dashboard.editWidget') : t('dashboard.addWidget')" class="dash-config-modal">
      <NForm label-placement="left" label-width="90">
        <NFormItem :label="t('dashboard.type')">
          <NSelect v-model:value="form.type" :options="typeOptions" />
        </NFormItem>
        <NFormItem :label="t('dashboard.label')" :required="true">
          <NInput v-model:value="form.label" :placeholder="t('dashboard.labelPlaceholder')" />
        </NFormItem>

        <template v-if="needsBind">
          <NFormItem :label="t('dashboard.decoder')">
            <NSelect v-model:value="form.decoderId" :options="decoderOptions" />
          </NFormItem>
          <NFormItem :label="t('dashboard.field')">
            <NSelect
              v-model:value="form.fieldName"
              :options="fieldOptions"
              filterable
              tag
              :placeholder="t('dashboard.fieldPlaceholder')"
            />
          </NFormItem>
          <NFormItem :label="t('dashboard.index')">
            <NInputNumber v-model:value="form.index" :min="0" :placeholder="t('dashboard.indexPlaceholder')" class="dash-index-input" />
          </NFormItem>
          <NFormItem :label="t('dashboard.unit')">
            <NInput v-model:value="form.unit" :placeholder="t('dashboard.unitPlaceholder')" />
          </NFormItem>
          <NFormItem v-if="form.type === 'digital'" :label="t('dashboard.thresholdLow')">
            <NInputNumber v-model:value="form.thresholdLow" :placeholder="t('dashboard.thresholdPlaceholder')" class="dash-index-input" />
          </NFormItem>
          <NFormItem v-if="form.type === 'digital'" :label="t('dashboard.thresholdHigh')">
            <NInputNumber v-model:value="form.thresholdHigh" :placeholder="t('dashboard.thresholdPlaceholder')" class="dash-index-input" />
          </NFormItem>
          <NFormItem v-if="form.type === 'digital'" :label="t('dashboard.decimals')">
            <NInputNumber v-model:value="form.decimals" :min="0" :max="6" class="dash-index-input" />
          </NFormItem>
        </template>
      </NForm>
      <div class="dash-config-actions">
        <NButton size="small" @click="showConfig = false">{{ t('dashboard.cancel') }}</NButton>
        <NButton size="small" type="primary" :disabled="!bindValid" @click="saveWidget">{{ t('dashboard.save') }}</NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.dashboard-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 10px 12px;
  gap: 10px;
  overflow: hidden;
}

/* —— 工具栏 —— */
.dash-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.dash-title {
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.5px;
}
.dash-add {
  appearance: none;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.dash-add:hover {
  color: var(--accent-violet);
  border-color: var(--accent-violet);
}

/* —— 卡片网格 —— */
.dash-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  grid-auto-rows: min-content;
  gap: 10px;
  align-content: start;
  padding: 2px;
}
.dash-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 8px);
  padding: 10px 12px;
  cursor: grab;
  transition: border-color 0.2s, box-shadow 0.2s;
  user-select: none;
}
.dash-card:hover {
  border-color: var(--accent-violet);
  box-shadow: var(--shadow-md);
}
.dash-card.type-field-table {
  grid-column: 1 / -1; /* 字段总览表通栏 */
}
/* 告警态：边框呼吸闪烁（仅数字表/LED 有状态） */
.dash-card.alarm {
  border-color: var(--err);
  animation: dash-alarm-pulse 1.2s ease-in-out infinite;
}
.dash-card.warn {
  border-color: var(--warn);
}
@keyframes dash-alarm-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--err) 35%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

.dash-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.dash-card-label {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-card-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.dash-card:hover .dash-card-actions {
  opacity: 1;
}
.dash-act {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.dash-act:hover {
  color: var(--text);
  background: var(--bg-elevated);
}

/* —— 数字表 —— */
.dash-digital {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dash-value {
  font-family: var(--mono-font);
  font-size: 30px;
  line-height: 1.1;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dash-card.alarm .dash-value {
  color: var(--err);
}
.dash-card.warn .dash-value {
  color: var(--warn);
}
.dash-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.dash-unit {
  font-size: 13px;
  color: var(--text-dim);
}
.dash-status {
  font-size: 11px;
  color: var(--text-dim);
}
.dash-status.alarm {
  color: var(--err);
}
.dash-status.warn {
  color: var(--warn);
}

/* —— 状态灯 —— */
.dash-led {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
}
.led-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex-shrink: 0;
}
.led-dot.alarm {
  background: var(--err);
  box-shadow: 0 0 8px var(--err);
  animation: dash-alarm-pulse 1.2s ease-in-out infinite;
}
.led-dot.warn {
  background: var(--warn);
  box-shadow: 0 0 6px var(--warn);
}
.led-dot:not(.alarm):not(.warn) {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}
.led-dot.off {
  background: var(--border);
  box-shadow: none;
}
.led-text {
  font-size: 13px;
  color: var(--text);
}

/* —— 字段总览表 —— */
.dash-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}
.dash-table-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
}
.dash-table-row:hover {
  background: var(--bg-elevated);
}
.dash-table-name {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 90px;
  font-family: var(--mono-font);
}
.dash-table-value {
  font-size: 12px;
  color: var(--text);
  font-family: var(--mono-font);
  word-break: break-all;
}

/* —— 卡片底部元信息 —— */
.dash-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.dash-threshold {
  font-family: var(--mono-font);
}
.dash-updated {
  font-family: var(--mono-font);
  white-space: nowrap;
}
.dash-nodata {
  font-size: 12px;
  color: var(--text-dim);
  padding: 8px 0;
}

/* —— 空态 —— */
.dash-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--text-dim);
}
.dash-empty-title {
  font-size: 14px;
  color: var(--text);
  margin: 0;
}
.dash-empty-hint {
  font-size: 12px;
  margin: 0;
  max-width: 360px;
  line-height: 1.6;
}

/* —— 配置弹窗 —— */
.dash-config-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.dash-index-input {
  width: 120px;
}
</style>
