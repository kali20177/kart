import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSerialStore, createSerialStore, type SerialDeps } from './serial'
import type { EndpointInfo, PortOptions, SerialSignals, IoTransport, DriverType } from '@/types'
import { STORAGE_PREFIX } from '@/composables/useStorage'
import { registerTransport } from '@/serial/registry'

const KEY = STORAGE_PREFIX + 'customBaudRates'

beforeEach(() => {
  setActivePinia(createPinia())
  // localStorage 由 src/test/setup.ts 统一提供（内存版，每用例重置）
  // registry 覆盖 rtt → 可 open 的假驱动：switchDriver/createDriverOfType 从注册表创建，
  // 真 RttDriver 无桥会拒 open，连接类用例需要可成功打开的驱动实例
  registerTransport({ type: 'rtt', create: () => new FakeRttDriver() })
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

  it('删除当前选中的自定义波特率 → 记录 removedCustomBauds；重新加入时解除', () => {
    const s = useSerialStore()
    s.options.baudRate = 500000
    s.addCustomBaudRate(500000)
    s.removeCustomBaudRate(500000)
    expect(s.removedCustomBauds).toEqual([500000]) // 删除的恰是当前值 → 下拉候选应立即排除

    // 删除非当前值不记录
    s.addCustomBaudRate(300000)
    s.removeCustomBaudRate(300000)
    expect(s.removedCustomBauds).toEqual([500000])

    // 重新输入/选择同值 → 重新加入列表并解除隐藏
    s.addCustomBaudRate(500000)
    expect(s.removedCustomBauds).toEqual([])
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
class FakeDriver implements IoTransport {
  readonly type: DriverType = 'serialport'
  isOpen = false
  signals: { dtr?: boolean; rts?: boolean } = {}
  break: boolean | null = null

  listEndpoints = async (): Promise<EndpointInfo[]> => []
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

// ── 写失败提前断连 ──

describe('serial store · 写失败提前断连（驱动已报断开，轮询未到）', () => {
  it('write 失败且 driver.isOpen=false → 立即断连并排程重连，而非等 500ms 轮询', async () => {
    // 自定义驱动：write 失败并报告物理断开（模拟远端断连后的窗口期）
    class DroppedDriver extends FakeDriver {
      override write = async (): Promise<void> => {
        throw new Error('连接已断开')
      }
    }
    const driver = new DroppedDriver()
    const deps: SerialDeps = {
      ingestRx: () => {},
      addTx: () => {},
      settings: { autoReconnect: true },
      createDriver: () => driver
    }
    const scope = effectScope(true)
    const store = scope.run(() => createSerialStore(deps))!
    store.selectedPort.value = 'COM1'
    await store.connect()
    expect(store.connected.value).toBe(true)

    // 模拟远端断连：驱动已报告 isOpen=false（signalTimer 500ms 轮询尚未触发）
    driver.isOpen = false
    const r = await store.send('hello', 'ascii', 'none', 'utf-8')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('连接已断开')
    // 提前断连：UI 状态立即恢复 + 自动重连已排程（disconnect 异步，flush 一次宏任务）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.connected.value).toBe(false)
    expect(store.reconnecting.value).toBe(true)
    scope.stop()
  })
})

// ── 驱动切换销毁（destroy?() 可选契约）──

describe('serial store · 切换驱动时旧驱动销毁', () => {
  it('旧驱动实现 destroy → 切换时被调用（不再依赖 instanceof 白名单）', async () => {
    class DestroyableDriver extends FakeDriver {
      destroyed = false
      destroy = () => { this.destroyed = true }
    }
    const driver = new DestroyableDriver()
    const { store, scope } = makeStore(driver)
    await store.switchDriver('tcp')
    expect(driver.destroyed).toBe(true)
    scope.stop()
  })

  it('旧驱动未实现 destroy → 可选链跳过，不抛错', async () => {
    const driver = new FakeDriver() // FakeDriver 无 destroy 方法
    const { store, scope } = makeStore(driver)
    await expect(store.switchDriver('tcp')).resolves.toBeUndefined()
    scope.stop()
  })
})

// ── RTT 传输类型（复用 TCP 通路，独立驱动标识/默认端口）──

/** 可成功 open 的 rtt 假驱动（registry 覆盖用；真 RttDriver 无桥会拒 open） */
class FakeRttDriver extends FakeDriver {
  readonly type: DriverType = 'rtt'
}

describe('serial store · RTT 传输类型', () => {
  it('transportType 三态映射：rtt 驱动 → rtt，tcp → tcp，其余串口后端 → serial', async () => {
    const { store, scope } = makeStore(new FakeDriver())
    await store.switchDriver('rtt')
    expect(store.transportType.value).toBe('rtt')
    await store.switchDriver('tcp')
    expect(store.transportType.value).toBe('tcp')
    await store.switchDriver('serialport')
    expect(store.transportType.value).toBe('serial')
    scope.stop()
  })

  it('rtt 连接前从 host/port 组装端点并打开 rtt 驱动', async () => {
    const { store, scope } = makeStore(new FakeDriver())
    await store.switchDriver('rtt')
    store.tcpOptions.host = '127.0.0.1'
    store.tcpOptions.port = 19021
    await store.connect()
    expect(store.selectedPort.value).toBe('127.0.0.1:19021')
    expect(store.connected.value).toBe(true)
    scope.stop()
  })

  it('rtt 端点校验：空主机/空端口明确报错（文案与 TCP 通用）', async () => {
    const { store, scope } = makeStore(new FakeDriver())
    await store.switchDriver('rtt')
    store.tcpOptions.port = 19021
    store.tcpOptions.host = ''
    await expect(store.connect()).rejects.toThrow('主机不能为空')
    store.tcpOptions.host = '1.2.3.4'
    store.tcpOptions.port = null
    await expect(store.connect()).rejects.toThrow('端口不能为空')
    scope.stop()
  })

  it('setTransport 切换默认端口：rtt → 19021 + host 127.0.0.1，tcp → 502（未自定义时）', async () => {
    const { store, scope } = makeStore(new FakeDriver())
    await store.setTransport('rtt')
    expect(store.tcpOptions.port).toBe(19021)
    expect(store.tcpOptions.host).toBe('127.0.0.1')
    expect(store.transportType.value).toBe('rtt')
    await store.setTransport('tcp')
    expect(store.tcpOptions.port).toBe(502)
    await store.setTransport('serial')
    // 回串口：默认端口整理不适用，保留当前网络态值
    expect(store.transportType.value).toBe('serial')
    scope.stop()
  })
})
