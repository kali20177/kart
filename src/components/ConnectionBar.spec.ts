import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import ConnectionBar from './ConnectionBar.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'

let wrappers: VueWrapper[] = []
let sessions: Session[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  // ConnectionBar 的 TCP 下拉选项由 window.electron?.tcp 决定：注入假桥让「TCP」可选
  window.electron = {
    tcp: {
      open: vi.fn(async () => {}),
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
})
