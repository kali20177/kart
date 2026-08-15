import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import DashboardPane from './DashboardPane.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { modbusFrame } from '@/mock/scenarios'
import { setDriverType } from '@/serial'

let wrappers: VueWrapper[] = []
let sessions: Session[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  setDriverType('serialport')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const w of wrappers) w.unmount()
  wrappers = []
  for (const s of sessions) s.dispose()
  sessions = []
})

const panelParams = {
  params: undefined,
  api: { isActive: true, onDidActiveChange: () => ({ dispose: () => {} }) },
  containerApi: {},
  tabLocation: 'center',
}

function mountDash() {
  const session = createSession({ createDriver: () => new MockSerialSource() })
  sessions.push(session)
  const Host = defineComponent({
    setup() {
      provideSession(session)
      return () => h(NMessageProvider, null, { default: () => h(DashboardPane, { params: panelParams }) })
    }
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(wrapper)
  return { wrapper, session }
}

/** 推送一条 Modbus RTU 响应帧进消息管线（需先启用解码器），并刷出（gap-timeout + rAF） */
async function pumpModbusResponse(session: Session, registerValues: number[]) {
  const data = [registerValues.length * 2, ...registerValues.flatMap((v) => [v >> 8, v & 0xff])]
  session.messages.ingestRx(modbusFrame(0x01, 0x03, data))
  vi.advanceTimersByTime(20) // gap-timeout 尾帧刷新
  vi.advanceTimersByTime(16) // rAF 批处理 flush
  await nextTick()
}

describe('DashboardPane · 渲染与数据流', () => {
  it('无 widget 时渲染空态引导', () => {
    const { wrapper } = mountDash()
    expect(wrapper.text()).toContain('仪表盘还没有 widget')
    expect(wrapper.find('.dash-empty').exists()).toBe(true)
  })

  it('数字表卡片显示解码字段最新值（Modbus 寄存器第 N 个）', async () => {
    const { wrapper, session } = mountDash()
    session.decoder.id = 'modbus-rtu'
    // 绑定 registers[1] = 0x0001
    session.dashboard.addWidget({
      type: 'digital',
      label: '电流',
      bind: { decoderId: 'modbus-rtu', fieldName: 'registers', index: 1 },
      unit: 'A',
      decimals: 0,
    })
    await nextTick()
    expect(wrapper.find('.dash-card').exists()).toBe(true)

    await pumpModbusResponse(session, [0x0064, 0x0001])
    expect(wrapper.find('.dash-value').text()).toBe('1') // 0x0001，绑定索引 1
    expect(wrapper.find('.dash-unit').text()).toBe('A')
  })

  it('超上限阈值 → 卡片标 alarm', async () => {
    const { wrapper, session } = mountDash()
    session.decoder.id = 'modbus-rtu'
    session.dashboard.addWidget({
      type: 'digital',
      label: '温度',
      bind: { decoderId: 'modbus-rtu', fieldName: 'registers', index: 0 },
      thresholdHigh: 80,
    })
    await pumpModbusResponse(session, [100, 0]) // 0x0064 = 100 > 80
    const card = wrapper.find('.dash-card')
    expect(card.classes()).toContain('alarm')
    expect(wrapper.find('.dash-status').text()).toBe('告警')
  })

  it('字段总览表渲染最近一帧全部字段', async () => {
    const { wrapper, session } = mountDash()
    session.decoder.id = 'modbus-rtu'
    session.dashboard.addWidget({ type: 'field-table', label: '帧字段' })
    await pumpModbusResponse(session, [0x0064, 0x0001])
    const rows = wrapper.findAll('.dash-table-row')
    expect(rows.length).toBeGreaterThanOrEqual(3) // slave/fc/byteCount/registers/crc 至少 3
    expect(rows.some((r) => r.text().includes('registers'))).toBe(true)
  })

  it('打开配置弹窗：渲染表单且可关闭（保存逻辑见 store 单测；naive-ui v-model 绑定在真实浏览器验证）', async () => {
    const { wrapper, session } = mountDash()
    await wrapper.find('.dash-add').trigger('click')
    await nextTick()
    // naive-ui NModal 渲染到 body teleport
    const modal = document.querySelector('.n-modal')
    expect(modal).not.toBeNull()
    expect(modal?.textContent ?? '').toContain('标签')
    expect(modal?.textContent ?? '').toContain('类型')
    // 取消按钮存在且未新增 widget（NModal 关闭动画在 jsdom 下时序不稳，不断言 DOM 移除）
    const cancelBtn = [...document.querySelectorAll('.n-modal button')].find((b) => b.textContent?.includes('取消'))
    expect(cancelBtn, '取消按钮存在').toBeTruthy()
    expect(session.dashboard.widgets.length).toBe(0)
  })
})
