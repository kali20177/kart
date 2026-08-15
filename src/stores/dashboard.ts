import { ref, shallowRef, onScopeDispose } from 'vue'
import type { DecodeField } from '@/decoders/types'
import type { DecodeBroadcast } from './messages'

/**
 * 仪表盘 store（会话内）：订阅帧解码广播 → 维护字段最新值表 + 最近一帧完整字段。
 *
 * 数据流：messages 在帧解码成功（matched）后经 onDecode 广播字段（含数值），
 * 本 store 按 `decoderId:fieldName:index` 键更新最新值表（widget 绑定取值用），
 * 并保存最近一帧的完整字段列表（字段总览表卡片渲染用）。
 * version 递增作组件刷新信号（shallowRef 原地替换不触发 length watch，同 waveform 模式）。
 *
 * 暂停语义：messages 在 paused 时 ingestRx 直接 return，广播天然冻结 → 仪表盘自动冻结。
 *
 * widget 配置（widgets 数组）由 session 按端口持久化（见 session/index.ts），本 store 只管内存态。
 */

/** widget 类型：digital=数字表（大数字+阈值着色）、led=状态灯、field-table=字段总览表 */
export type DashboardWidgetType = 'digital' | 'led' | 'field-table'

/** widget 数据源绑定：解码器 id + 字段名 + 多值字段索引（number[] 字段的第 N 个值） */
export interface DashboardBind {
  decoderId: string
  fieldName: string
  /** 多值字段（如 Modbus 寄存器组）的下标；标量字段省略 */
  index?: number
}

export interface DashboardWidget {
  id: string
  type: DashboardWidgetType
  label: string
  bind?: DashboardBind
  unit?: string
  /** 小数位（数字表） */
  decimals?: number
  /** 硬阈值：低于/高于即告警（alarm） */
  thresholdLow?: number
  thresholdHigh?: number
  /** 软阈值：低于/高于即预警（warn）——扩展位，配置表单首期只暴露硬阈值 */
  warnLow?: number
  warnHigh?: number
}

/** 字段最新值快照（widget 绑定取值源） */
export interface FieldSnapshot {
  /** 原始显示值（格式化字符串） */
  display: string
  /** 数值；无数值语义的字段省略 */
  number?: number | number[]
  /** 最近一次到达时间（帧时间戳） */
  timestamp: number
}

/** 最近一帧完整字段（字段总览表卡片渲染源） */
export interface DecodeFrameSnapshot {
  decoderId: string
  fields: DecodeField[]
  timestamp: number
}

/** 阈值状态：normal 正常 / warn 预警 / alarm 告警 */
export type FieldStatus = 'normal' | 'warn' | 'alarm'

/**
 * 阈值判定纯函数（可单测）：无值/非有限值视为 normal；alarm 优先于 warn。
 * 单侧阈值只校验该侧（未配置的阈值不拦截）。
 */
export function fieldStatus(
  w: Pick<DashboardWidget, 'thresholdLow' | 'thresholdHigh' | 'warnLow' | 'warnHigh'>,
  value: number | undefined
): FieldStatus {
  if (value === undefined || !Number.isFinite(value)) return 'normal'
  if (w.thresholdLow !== undefined && value < w.thresholdLow) return 'alarm'
  if (w.thresholdHigh !== undefined && value > w.thresholdHigh) return 'alarm'
  if (w.warnLow !== undefined && value < w.warnLow) return 'warn'
  if (w.warnHigh !== undefined && value > w.warnHigh) return 'warn'
  return 'normal'
}

/** widget 数据源键：解码器 + 字段名 + 索引唯一确定一个数值 */
export function fieldKey(decoderId: string, fieldName: string, index?: number): string {
  return `${decoderId}:${fieldName}:${index ?? ''}`
}

export interface DashboardDeps {
  onDecode: (cb: (info: DecodeBroadcast) => void) => () => void
}

export function createDashboardStore(deps: DashboardDeps) {
  /** widget 卡片配置（会话级，由 session 持久化） */
  const widgets = ref<DashboardWidget[]>([])
  /** 字段最新值表：fieldKey → 快照（widget 绑定取值源） */
  const latestFields = shallowRef<Record<string, FieldSnapshot>>({})
  /** 最近一帧完整字段（字段总览表渲染源） */
  const lastFrame = shallowRef<DecodeFrameSnapshot | null>(null)
  /** 更新信号：每次新字段值到达递增，组件按此刷新（shallowRef 原地替换无法 watch 长度） */
  const version = ref(0)

  let widgetSeq = 1
  let _unsubDecode: (() => void) | null = null

  function handleDecode({ decoderId, fields, timestamp }: DecodeBroadcast) {
    const next = { ...latestFields.value }
    for (const f of fields) {
      if (Array.isArray(f.number)) {
        // 多值字段：每个值一个键（number 数组与 value 串顺序一致），支持"第 N 个"绑定
        f.number.forEach((n, i) => {
          next[fieldKey(decoderId, f.name, i)] = { display: f.value, number: n, timestamp }
        })
      } else {
        const snap: FieldSnapshot = { display: f.value, timestamp }
        if (f.number !== undefined) snap.number = f.number
        next[fieldKey(decoderId, f.name)] = snap
      }
    }
    latestFields.value = next
    lastFrame.value = { decoderId, fields, timestamp }
    version.value++
  }

  // ── widget CRUD ──

  function addWidget(w: Omit<DashboardWidget, 'id'>): DashboardWidget {
    const widget: DashboardWidget = { ...w, id: `w${Date.now().toString(36)}${(widgetSeq++).toString(36)}` }
    widgets.value = [...widgets.value, widget]
    return widget
  }

  function removeWidget(id: string): void {
    widgets.value = widgets.value.filter((w) => w.id !== id)
  }

  function updateWidget(id: string, patch: Partial<Omit<DashboardWidget, 'id'>>): void {
    widgets.value = widgets.value.map((w) => (w.id === id ? { ...w, ...patch } : w))
  }

  /** 拖拽排序：把 fromIndex 位置元素移动到 toIndex */
  function moveWidget(fromIndex: number, toIndex: number): void {
    const arr = widgets.value.slice()
    if (fromIndex < 0 || fromIndex >= arr.length || toIndex < 0 || toIndex >= arr.length) return
    const [m] = arr.splice(fromIndex, 1)
    arr.splice(toIndex, 0, m)
    widgets.value = arr
  }

  /** 从持久化恢复 widget 列表（session 切端口载入用） */
  function setWidgets(list: DashboardWidget[]): void {
    widgets.value = list
  }

  /** 读取 widget 绑定的最新数值与显示信息（无数值/无快照 → undefined） */
  function widgetSnapshot(w: DashboardWidget): { value: number | undefined; display: string; timestamp: number } | undefined {
    if (!w.bind) return undefined
    const snap = latestFields.value[fieldKey(w.bind.decoderId, w.bind.fieldName, w.bind.index)]
    if (!snap) return undefined
    const value = snap.number !== undefined
      ? (Array.isArray(snap.number) ? snap.number[0] : snap.number)
      : undefined
    return { value, display: snap.display, timestamp: snap.timestamp }
  }

  /** 清空数据快照（保留 widget 配置）；联动 pause.clearAll 链 */
  function clear(): void {
    latestFields.value = {}
    lastFrame.value = null
    version.value++
  }

  _unsubDecode = deps.onDecode(handleDecode)
  onScopeDispose(() => {
    _unsubDecode?.()
    _unsubDecode = null
  })

  return { widgets, latestFields, lastFrame, version, addWidget, removeWidget, updateWidget, moveWidget, setWidgets, widgetSnapshot, clear }
}
