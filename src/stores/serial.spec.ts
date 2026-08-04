import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSerialStore, createSerialStore, type SerialDeps } from './serial'
import type { PortInfo, PortOptions, SerialSignals, SerialDriver } from '@/types'
import { STORAGE_PREFIX } from '@/composables/useStorage'

const KEY = STORAGE_PREFIX + 'customBaudRates'

beforeEach(() => {
  setActivePinia(createPinia())
  // localStorage 由 src/test/setup.ts 统一提供（内存版，每用例重置）
})

describe('serial store · 自定义波特率', () => {
  it('预设档位与已存在项不会被重复加入，结果升序持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.addCustomBaudRate(300000)
    s.addCustomBaudRate(74880) // 预设，应忽略
    s.addCustomBaudRate(500000) // 已存在，应忽略
    expect(s.customBaudRates.map((c) => c.baud)).toEqual([300000, 500000])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      { baud: 300000 },
      { baud: 500000 }
    ])
  })

  it('删除自定义波特率并持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.removeCustomBaudRate(500000)
    expect(s.customBaudRates).toEqual([])
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('更新标注，空串/空白清除标注', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.updateCustomBaudNote(500000, '我的设备')
    expect(s.customBaudRates[0].note).toBe('我的设备')
    s.updateCustomBaudNote(500000, '   ')
    expect(s.customBaudRates[0].note).toBeUndefined()
  })

  it('加载时兼容旧版 number[] 格式', () => {
    localStorage.setItem(KEY, JSON.stringify([74880, 500000]))
    const s = useSerialStore()
    expect(s.customBaudRates).toEqual([{ baud: 74880 }, { baud: 500000 }])
  })

  it('非法 baud（0/负/小数/越界）不会被加入', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(0)
    s.addCustomBaudRate(-1)
    s.addCustomBaudRate(1.5)
    s.addCustomBaudRate(99_999_999)
    expect(s.customBaudRates).toEqual([])
  })
})

describe('serial store · reset', () => {
  it('恢复端口参数与自定义波特率默认值；portOptions 不再落盘（多会话 v1：端口参数仅存会话内存）', () => {
    const s = useSerialStore()
    // 污染：改端口参数 + 加自定义波特率
    s.options.baudRate = 9600
    s.options.parity = 'even'
    s.addCustomBaudRate(500000)
    expect(s.customBaudRates.length).toBe(1)

    s.reset()

    // 内存：端口参数回默认
    expect(s.options).toEqual({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    })
    // 内存：自定义波特率清空
    expect(s.customBaudRates).toEqual([])
    // 落盘：仅自定义波特率清空；portOptions 不再写入
    expect(localStorage.getItem(KEY)).toBe('[]')
    expect(localStorage.getItem(STORAGE_PREFIX + 'portOptions')).toBeNull()
  })
})

// ── 输出线控制（DTR/RTS/Break）──

/** 记录调用痕迹的假驱动：setSignals/setBreak 写入 observable 状态供断言 */
class FakeDriver implements SerialDriver {
  isOpen = false
  signals: { dtr?: boolean; rts?: boolean } = {}
  break: boolean | null = null

  listPorts = async (): Promise<PortInfo[]> => []
  open = async (_path: string, _options: PortOptions): Promise<void> => {
    this.isOpen = true
  }
  close = async (): Promise<void> => {
    this.isOpen = false
  }
  write = async (_bytes: Uint8Array): Promise<void> => {}
  getSignals = (): SerialSignals => ({ dcd: false, cts: false, dsr: false, ri: false })
  setSignals = async (s: { dtr?: boolean; rts?: boolean }): Promise<void> => {
    if (s.dtr !== undefined) this.signals.dtr = s.dtr
    if (s.rts !== undefined) this.signals.rts = s.rts
  }
  setBreak = async (active: boolean): Promise<void> => {
    this.break = active
  }
  onData = (_cb: (bytes: Uint8Array) => void): (() => void) => () => {}
}

/** 用假驱动在独立 effectScope 中创建 serial store（scope.stop 触发 onScopeDispose 清理） */
function makeStore(driver: FakeDriver) {
  const deps: SerialDeps = {
    ingestRx: () => {},
    addTx: () => {},
    settings: { autoReconnect: false },
    createDriver: () => driver
  }
  const scope = effectScope(true)
  const store = scope.run(() => createSerialStore(deps))!
  return { store, scope }
}

describe('serial store · 输出线控制（DTR/RTS/Break）', () => {
  it('setDtr/setRts 连接时下发驱动并更新 UI 状态', async () => {
    const driver = new FakeDriver()
    const { store, scope } = makeStore(driver)
    store.selectedPort.value = 'COM1'
    await store.connect()
    await store.setDtr(true)
    await store.setRts(false)
    expect(driver.signals).toEqual({ dtr: true, rts: false })
    expect(store.dtr.value).toBe(true)
    expect(store.rts.value).toBe(false)
    await store.userDisconnect()
    scope.stop()
  })

  it('驱动 setSignals 失败时回滚 UI 状态', async () => {
    const driver = new FakeDriver()
    driver.setSignals = async () => {
      throw new Error('硬件不支持')
    }
    const { store, scope } = makeStore(driver)
    store.selectedPort.value = 'COM1'
    await store.connect()
    await expect(store.setDtr(true)).rejects.toThrow('硬件不支持')
    expect(store.dtr.value).toBe(false)
    await store.userDisconnect()
    scope.stop()
  })

  it('未连接时仅记录意图，连接后自动重放 DTR/RTS', async () => {
    const driver = new FakeDriver()
    const { store, scope } = makeStore(driver)
    await store.setDtr(true)
    expect(store.dtr.value).toBe(true)
    expect(driver.signals.dtr).toBeUndefined() // 未连接不下发
    store.selectedPort.value = 'COM1'
    await store.connect()
    expect(driver.signals).toEqual({ dtr: true, rts: false }) // 重放
    await store.userDisconnect()
    scope.stop()
  })

  it('pulseBreak 置位后 250ms 复位，期间 breakBusy 为 true', async () => {
    vi.useFakeTimers()
    try {
      const driver = new FakeDriver()
      const { store, scope } = makeStore(driver)
      store.selectedPort.value = 'COM1'
      await store.connect()
      const p = store.pulseBreak()
      expect(driver.break).toBe(true)
      expect(store.breakBusy.value).toBe(true)
      await vi.advanceTimersByTimeAsync(250)
      await p
      expect(driver.break).toBe(false)
      expect(store.breakBusy.value).toBe(false)
      await store.userDisconnect()
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未连接时 pulseBreak 不动作', async () => {
    const driver = new FakeDriver()
    const { store, scope } = makeStore(driver)
    await store.pulseBreak()
    expect(driver.break).toBeNull()
    expect(store.breakBusy.value).toBe(false)
    scope.stop()
  })
})
