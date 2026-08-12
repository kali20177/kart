import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import StatusBar from './StatusBar.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import type { EndpointInfo, PortOptions, SerialSignals, IoTransport, DriverType } from '@/types'

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

let wrappers: VueWrapper[] = []
let sessions: Session[] = []

function mountStatusBar(driver: IoTransport) {
  setActivePinia(createPinia())
  const session = createSession({ createDriver: () => driver })
  sessions.push(session)
  const Host = defineComponent({
    setup() {
      provideSession(session)
      return () => h(NMessageProvider, null, { default: () => h(StatusBar) })
    }
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] } })
  wrappers.push(wrapper)
  return { wrapper, session }
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  for (const s of sessions) s.dispose()
  sessions = []
})

describe('StatusBar · 输出线控制（DTR/RTS/Break）', () => {
  it('渲染 DTR/RTS/BRK 控制按钮与只读 CTS 指示', () => {
    const { wrapper } = mountStatusBar(new FakeDriver())
    const btns = wrapper.findAll('.signal-btn')
    expect(btns.map((b) => b.text())).toEqual(['DTR', 'RTS', 'BRK'])
    expect(wrapper.find('.signal-ro').exists()).toBe(true)
  })

  it('CTS 为只读指示：span 非按钮，tooltip 注明只读，圆点随信号状态切换', async () => {
    const { wrapper, session } = mountStatusBar(new FakeDriver())
    const cts = wrapper.find('.signal-ro')
    expect(cts.element.tagName).toBe('SPAN') // 非 button，无点击语义
    expect(cts.classes()).not.toContain('signal-btn')
    expect(cts.attributes('title')).toContain('只读')

    // 圆点 active 类跟随 serial.signals.cts
    expect(cts.classes()).not.toContain('active')
    session.serial.signals.cts = true
    await nextTick()
    expect(wrapper.find('.signal-ro').classes()).toContain('active')
  })

  it('未连接时控制按钮禁用', () => {
    const { wrapper } = mountStatusBar(new FakeDriver())
    for (const b of wrapper.findAll('.signal-btn')) {
      expect(b.attributes('disabled')).toBeDefined()
    }
  })

  it('连接后点击 DTR 切换电平并下发驱动', async () => {
    const driver = new FakeDriver()
    const { wrapper, session } = mountStatusBar(driver)
    session.serial.selectedPort = 'COM1'
    await session.serial.connect()
    await nextTick()
    const dtr = wrapper.findAll('.signal-btn')[0]
    expect(dtr.attributes('disabled')).toBeUndefined() // 连接后可用
    await dtr.trigger('click')
    await nextTick()
    expect(session.serial.dtr).toBe(true)
    expect(driver.signals.dtr).toBe(true)
  })

  it('连接后点击 RTS 切换电平并下发驱动', async () => {
    const driver = new FakeDriver()
    const { wrapper, session } = mountStatusBar(driver)
    session.serial.selectedPort = 'COM1'
    await session.serial.connect()
    await nextTick()
    const rts = wrapper.findAll('.signal-btn')[1]
    await rts.trigger('click')
    await nextTick()
    expect(session.serial.rts).toBe(true)
    expect(driver.signals.rts).toBe(true)
  })
})
