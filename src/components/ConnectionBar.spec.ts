import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider, NSelect } from 'naive-ui'
import ConnectionBar from './ConnectionBar.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { setDriverType } from '@/serial'

let wrappers: VueWrapper[] = []
let sessions: Session[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  // 重置模块级驱动解析态：switchDriver 在 DEV 下会 setDriverType，不重置会让
  // 后续用例的 store 初始化拿到被污染的 driverType（如上一用例切过的 'tcp'）。
  setDriverType('serialport')
  // ConnectionBar 的 TCP 下拉选项由 window.electron?.tcp 决定：注入假桥让「TCP」可选
  window.electron = {
    tcp: {
      open: vi.fn(async () => 'conn-1'),
      close: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      onData: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {})
    }
  } as unknown as NonNullable<typeof window.electron>
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  for (const s of sessions) s.dispose()
  sessions = []
  window.electron = undefined as unknown as NonNullable<typeof window.electron>
})

function mountBar() {
  const session = createSession({ createDriver: () => new MockSerialSource() })
  sessions.push(session)
  const Host = defineComponent({
    setup() {
      provideSession(session)
      return () => h(NMessageProvider, null, { default: () => h(ConnectionBar) })
    }
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] } })
  wrappers.push(wrapper)
  return { wrapper, session }
}

describe('ConnectionBar · TCP 传输输入', () => {
  it('切换到 TCP 后渲染主机与端口两个输入框（端口框此前因 NInputNumber 未导入而不显示）', async () => {
    const { wrapper, session } = mountBar()
    // 默认串口模式：无 TCP 输入框
    expect(wrapper.find('input[placeholder="主机 / IP"]').exists()).toBe(false)

    await session.serial.setTransport('tcp')
    await nextTick()
    expect(session.serial.transportType).toBe('tcp')
    // 主机输入 + 端口数字输入都应渲染
    expect(wrapper.find('input[placeholder="主机 / IP"]').exists()).toBe(true)
    expect(wrapper.find('input[placeholder="端口"]').exists()).toBe(true)
  })

  it('DEV 下无 Electron 桥也可选 TCP（仅放开选择；无桥连接时明确报错）', async () => {
    // 覆盖 beforeEach 注入的桥：模拟纯浏览器 dev（无 preload 桥）
    window.electron = undefined as unknown as NonNullable<typeof window.electron>
    const { wrapper, session } = mountBar()

    // 传输选择器仍提供 TCP 选项（DEV 放开选择，不依赖桥是否存在）——回归 gate: isDev || !!electron.tcp
    const transportSelect = wrapper.findAllComponents(NSelect)[0]
    const options = transportSelect?.props('options') as Array<{ value: string }> | undefined
    expect(options?.map((o) => o.value)).toEqual(['serial', 'tcp'])

    // 切换到 TCP → 主机/端口输入框渲染
    await session.serial.setTransport('tcp')
    await nextTick()
    expect(wrapper.find('input[placeholder="主机 / IP"]').exists()).toBe(true)

    // 无桥连接 → 明确报「TCP 不可用」，而不是静默失败/卡死
    session.serial.tcpOptions.host = '192.168.1.5'
    session.serial.tcpOptions.port = 502
    await expect(session.serial.connect()).rejects.toThrow('TCP 不可用')
  })
})

describe('ConnectionBar · 自定义波特率下拉', () => {
  it('删除当前选中的自定义波特率 → 下拉候选中立即消失（不再等重启）', async () => {
    const { wrapper, session } = mountBar()
    session.serial.options.baudRate = 500000
    session.serial.addCustomBaudRate(500000)
    await nextTick()
    const baudOptions = () => {
      const baud = wrapper.findAllComponents(NSelect).find((n) => n.props('value') === session.serial.options.baudRate)
      return (baud?.props('options') ?? []) as Array<{ value: number }>
    }
    expect(baudOptions().some((o) => o.value === 500000)).toBe(true)

    // × 删除当前值 → 立即从候选中消失（「当前值强制可选」不应把它带回来）
    session.serial.removeCustomBaudRate(500000)
    await nextTick()
    expect(baudOptions().some((o) => o.value === 500000)).toBe(false)

    // 重新输入同值 → 回到候选
    session.serial.addCustomBaudRate(500000)
    await nextTick()
    expect(baudOptions().some((o) => o.value === 500000)).toBe(true)
  })
})
