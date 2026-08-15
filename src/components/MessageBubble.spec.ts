import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import MessageBubble from './MessageBubble.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { setDriverType } from '@/serial'
import type { Message } from '@/types'

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

/** 一条带解码字段的消息（Modbus 响应帧的字段） */
function decodedMessage(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    direction: 'rx',
    bytes: new Uint8Array([0x01, 0x03, 0x04, 0x00, 0x64, 0x00, 0x01, 0x00, 0x00]),
    timestamp: 1000,
    decoded: {
      decoderId: 'modbus-rtu',
      summary: 'MB: slave=0x01 fc=0x03',
      fields: [
        { name: 'slave', value: '0x01', offset: 0, length: 1, number: 1 },
        { name: 'fc', value: '0x03 Read Holding Registers', offset: 1, length: 1, number: 3 },
        // 多值字段：寄存器组（数组）
        { name: 'registers', value: '0x0064, 0x0001', offset: 3, length: 4, number: [100, 1] },
      ],
    },
    ...over,
  }
}

function mountBubble(message: Message) {
  const session = createSession({ createDriver: () => new MockSerialSource() })
  sessions.push(session)
  const Host = defineComponent({
    setup() {
      provideSession(session)
      return () =>
        h(NMessageProvider, null, {
          default: () =>
            h(MessageBubble, {
              message,
              viewMode: 'ascii',
              encoding: 'utf-8',
            }),
        })
    },
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(wrapper)
  return { wrapper, session }
}

describe('MessageBubble · 解码字段 chip 右键添加至仪表盘', () => {
  it('右键多值字段 chip 弹出逐值子菜单，选中后创建对应索引卡片', async () => {
    const { wrapper, session } = mountBubble(decodedMessage())
    const chips = wrapper.findAll('.decoded-field')
    expect(chips.length).toBe(3)

    // 右键 registers chip（多值字段）→ 菜单列出每个寄存器
    await chips[2].trigger('contextmenu', { clientX: 120, clientY: 80 })
    await nextTick()
    const menu = document.querySelector('.n-dropdown-menu')
    expect(menu).not.toBeNull()
    const optionTexts = [...(document.querySelectorAll('.n-dropdown-option') ?? [])].map((o) => o.textContent ?? '')
    expect(optionTexts.some((t) => t.includes('registers[1]'))).toBe(true)

    // 点选 registers[1] → 创建 label=registers[1]、index=1 的数字表卡片
    // （naive-ui click 绑定在 .n-dropdown-option-body 上）
    const opt1 = [...document.querySelectorAll('.n-dropdown-option-body')].find((o) => o.textContent?.includes('registers[1]'))
    expect(opt1, 'registers[1] 选项存在').toBeTruthy()
    opt1?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(session.dashboard.widgets.length).toBe(1)
    const w = session.dashboard.widgets[0]
    expect(w).toMatchObject({
      type: 'digital',
      label: 'registers[1]',
      bind: { decoderId: 'modbus-rtu', fieldName: 'registers', index: 1 },
    })
    // 预填阈值上限 = 当前值 ×2（registers[1] = 1 → 2）
    expect(w.thresholdHigh).toBe(2)
  })

  it('右键标量字段 chip 单项菜单，选中后创建 index 省略的卡片', async () => {
    const { wrapper, session } = mountBubble(decodedMessage())
    const chips = wrapper.findAll('.decoded-field')

    await chips[0].trigger('contextmenu', { clientX: 100, clientY: 60 }) // slave 字段
    await nextTick()
    const menu = document.querySelector('.n-dropdown-menu')
    expect(menu?.textContent ?? '').toContain('添加至仪表盘')
    const opt = document.querySelector('.n-dropdown-option-body')
    opt?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(session.dashboard.widgets.length).toBe(1)
    const w = session.dashboard.widgets[0]
    expect(w.type).toBe('digital')
    expect(w.label).toBe('slave')
    // 标量字段：bind 不含 index 键
    expect(w.bind).toEqual({ decoderId: 'modbus-rtu', fieldName: 'slave' })
  })

  it('chip 右键不冒泡到行级多选菜单（stopPropagation）', async () => {
    const { wrapper } = mountBubble(decodedMessage())
    const rowContext = vi.fn()
    wrapper.find('.row').getCurrentComponent() // 触碰行容器确保存在
    const row = wrapper.find('.row')
    row.trigger('contextmenu', { clientX: 10, clientY: 10 })
    row.trigger('contextmenu', { clientX: 10, clientY: 10 }) // 行级事件可触发
    const chip = wrapper.findAll('.decoded-field')[0]
    // 在 chip 上触发 contextmenu 并断言行容器未收到（通过监听原生冒泡计数）
    const bubbles: unknown[] = []
    row.element.addEventListener('contextmenu', (e) => bubbles.push(e))
    chip.trigger('contextmenu', { clientX: 100, clientY: 60 })
    await nextTick()
    // chip 处理器调用了 stopPropagation → 行容器监听器不收到该事件
    expect(bubbles).toHaveLength(0)
    expect(rowContext).toBeDefined()
  })
})
