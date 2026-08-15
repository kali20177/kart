import { describe, it, expect } from 'vitest'
import { effectScope } from 'vue'
import { createDashboardStore, fieldStatus, fieldKey } from './dashboard'
import type { DashboardWidget } from './dashboard'
import type { DecodeBroadcast } from './messages'

/** 构造一个解码广播（寄存器字段：标量 fc + 多值 registers） */
function broadcast(decoderId = 'modbus-rtu', over: Partial<DecodeBroadcast> = {}): DecodeBroadcast {
  return {
    decoderId,
    fields: [
      { name: 'fc', value: '0x03 Read Holding Registers', offset: 1, length: 1, number: 0x03 },
      { name: 'registers', value: '0x0064, 0x0001', offset: 3, length: 4, number: [100, 1] }
    ],
    timestamp: 1000,
    ...over
  }
}

/** 挂一个 onDecode 订阅的 dashboard store（effectScope 包裹，避免 onScopeDispose 无作用域警告） */
function makeStore() {
  const listeners = new Set<(info: DecodeBroadcast) => void>()
  const emit = (info: DecodeBroadcast) => {
    for (const cb of [...listeners]) cb(info)
  }
  let store!: ReturnType<typeof createDashboardStore>
  effectScope().run(() => {
    store = createDashboardStore({
      onDecode: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    })
  })
  return { store, emit }
}

describe('dashboard store · 解码广播更新', () => {
  it('标量字段按键存最新值，多值字段按索引存', () => {
    const { store, emit } = makeStore()
    emit(broadcast())
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'fc')]).toMatchObject({ number: 0x03 })
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'registers', 0)]).toMatchObject({ number: 100 })
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'registers', 1)]).toMatchObject({ number: 1 })
  })

  it('同键更新覆盖旧值并递增 version', () => {
    const { store, emit } = makeStore()
    emit(broadcast())
    const v1 = store.version.value
    emit(broadcast('modbus-rtu', { fields: [
      { name: 'registers', value: '0x0065', offset: 3, length: 4, number: [101] }
    ] }))
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'registers', 0)].number).toBe(101)
    expect(store.version.value).toBe(v1 + 1)
  })

  it('最近一帧字段快照随广播刷新（字段总览表渲染源）', () => {
    const { store, emit } = makeStore()
    emit(broadcast())
    expect(store.lastFrame.value?.fields.map((f) => f.name)).toEqual(['fc', 'registers'])
    emit(broadcast('modbus-rtu', { fields: [{ name: 'slave', value: '0x01', offset: 0, length: 1, number: 1 }] }))
    expect(store.lastFrame.value?.fields.map((f) => f.name)).toEqual(['slave'])
  })

  it('单值数组字段兼写无下标键（只读 1 个寄存器：省略 index 的绑定也可取到值）', () => {
    const { store, emit } = makeStore()
    emit(broadcast('modbus-rtu', { fields: [{ name: 'registers', value: '0x0064', offset: 3, length: 2, number: [100] }] }))
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'registers')]).toMatchObject({ number: 100 })
    expect(store.latestFields.value[fieldKey('modbus-rtu', 'registers', 0)]).toMatchObject({ number: 100 })
    // 无下标绑定的 widget 能读到值——覆盖单寄存器响应 + 手动配置省略 index 的路径
    const w = store.addWidget({ type: 'digital', label: 'R', bind: { decoderId: 'modbus-rtu', fieldName: 'registers' } })
    expect(store.widgetSnapshot(w)).toMatchObject({ value: 100 })
  })

  it('clear 清空数据快照但保留 widgets，version 递增', () => {
    const { store, emit } = makeStore()
    emit(broadcast())
    store.addWidget({ type: 'digital', label: '转速', bind: { decoderId: 'modbus-rtu', fieldName: 'registers', index: 0 } })
    const v1 = store.version.value
    store.clear()
    expect(Object.keys(store.latestFields.value)).toHaveLength(0)
    expect(store.lastFrame.value).toBeNull()
    expect(store.version.value).toBe(v1 + 1)
    expect(store.widgets.value).toHaveLength(1)
  })
})

describe('dashboard store · widget CRUD', () => {
  it('addWidget 生成 id 并追加，removeWidget 删除', () => {
    const { store } = makeStore()
    const w = store.addWidget({ type: 'digital', label: 'A' })
    expect(w.id).toBeTruthy()
    store.addWidget({ type: 'led', label: 'B' })
    expect(store.widgets.value).toHaveLength(2)
    store.removeWidget(w.id)
    expect(store.widgets.value.map((x) => x.label)).toEqual(['B'])
  })

  it('updateWidget 局部更新', () => {
    const { store } = makeStore()
    const w = store.addWidget({ type: 'digital', label: 'A', thresholdHigh: 100 })
    store.updateWidget(w.id, { thresholdHigh: 85, unit: '℃' })
    expect(store.widgets.value[0]).toMatchObject({ label: 'A', thresholdHigh: 85, unit: '℃' })
  })

  it('moveWidget 拖拽排序，非法下标忽略', () => {
    const { store } = makeStore()
    store.addWidget({ type: 'digital', label: 'A' })
    store.addWidget({ type: 'digital', label: 'B' })
    store.addWidget({ type: 'digital', label: 'C' })
    store.moveWidget(0, 2)
    expect(store.widgets.value.map((w) => w.label)).toEqual(['B', 'C', 'A'])
    store.moveWidget(0, 99) // 越界忽略
    expect(store.widgets.value.map((w) => w.label)).toEqual(['B', 'C', 'A'])
  })

  it('setWidgets 从持久化恢复', () => {
    const { store } = makeStore()
    const restored: DashboardWidget[] = [
      { id: 'w1', type: 'digital', label: 'X', bind: { decoderId: 'm', fieldName: 'r', index: 0 } }
    ]
    store.setWidgets(restored)
    expect(store.widgets.value).toEqual(restored)
  })

  it('widgetSnapshot 读取绑定最新值；无快照返回 undefined', () => {
    const { store, emit } = makeStore()
    const w = store.addWidget({ type: 'digital', label: '转速', bind: { decoderId: 'modbus-rtu', fieldName: 'registers', index: 1 } })
    expect(store.widgetSnapshot(w)).toBeUndefined()
    emit(broadcast())
    expect(store.widgetSnapshot(w)).toMatchObject({ value: 1 })
    // 无数值字段绑定 → value undefined 但有 display
    const w2 = store.addWidget({ type: 'led', label: 'crc', bind: { decoderId: 'modbus-rtu', fieldName: 'crc' } })
    emit(broadcast('modbus-rtu', { fields: [{ name: 'crc', value: 'C5 CD', offset: 6, length: 2 }] }))
    expect(store.widgetSnapshot(w2)).toMatchObject({ value: undefined, display: 'C5 CD' })
  })
})

describe('dashboard · 阈值纯函数 fieldStatus', () => {
  it('无值/非有限值 → normal', () => {
    expect(fieldStatus({}, undefined)).toBe('normal')
    expect(fieldStatus({ thresholdHigh: 10 }, Number.NaN)).toBe('normal')
    expect(fieldStatus({ thresholdHigh: 10 }, Infinity)).toBe('normal')
  })

  it('硬阈值：低于/高于即 alarm，边界等于不算', () => {
    const w = { thresholdLow: 5, thresholdHigh: 85 }
    expect(fieldStatus(w, 4)).toBe('alarm')
    expect(fieldStatus(w, 86)).toBe('alarm')
    expect(fieldStatus(w, 5)).toBe('normal')
    expect(fieldStatus(w, 85)).toBe('normal')
    expect(fieldStatus(w, 50)).toBe('normal')
  })

  it('单侧阈值只校验该侧', () => {
    expect(fieldStatus({ thresholdHigh: 10 }, 5)).toBe('normal')
    expect(fieldStatus({ thresholdHigh: 10 }, 11)).toBe('alarm')
    expect(fieldStatus({ thresholdLow: -5 }, 10)).toBe('normal')
    expect(fieldStatus({ thresholdLow: -5 }, -10)).toBe('alarm')
  })

  it('软阈值 warn 档，alarm 优先', () => {
    const w = { warnHigh: 75, thresholdHigh: 85 }
    expect(fieldStatus(w, 70)).toBe('normal')
    expect(fieldStatus(w, 80)).toBe('warn')
    expect(fieldStatus(w, 90)).toBe('alarm')
  })
})
