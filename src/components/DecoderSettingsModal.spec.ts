import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import DecoderSettingsModal from './DecoderSettingsModal.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { setDriverType } from '@/serial'
import type { FieldDecoderOptions } from '@/decoders'

let wrappers: VueWrapper[] = []
let sessions: Session[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  setDriverType('serialport')
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  for (const s of sessions) s.dispose()
  sessions = []
  document.body.innerHTML = ''
})

function mountModal() {
  const session = createSession({ createDriver: () => new MockSerialSource() })
  sessions.push(session)
  const Host = defineComponent({
    setup() {
      provideSession(session)
      return () => h(NMessageProvider, null, { default: () => h(DecoderSettingsModal, { show: true }) })
    }
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
  wrappers.push(wrapper)
  return { wrapper, session }
}

/** naive-ui NModal 渲染到 body teleport，从 document 取弹窗根元素 */
function modalEl(): HTMLElement {
  const el = document.querySelector('.n-modal')
  if (!el) throw new Error('NModal 未渲染')
  return el as HTMLElement
}

function clickModalButton(text: string): HTMLElement {
  const btn = [...document.querySelectorAll('.n-modal button')].find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`弹窗内未找到按钮: ${text}`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return btn as HTMLElement
}

describe('DecoderSettingsModal · 会话级帧解码配置', () => {
  it('打开后渲染标题、解码器下拉与「无」默认选中态', async () => {
    mountModal()
    const text = modalEl().textContent ?? ''
    expect(text).toContain('帧解码')
    expect(text).toContain('解码器')
    expect(text).toContain('无')
  })

  it('默认 id 为空（无）→ 不渲染字段编辑器', async () => {
    mountModal()
    expect(modalEl().textContent ?? '').not.toContain('字段布局')
  })

  it('选字段解码器 → 显示字段编辑器，添加/删除字段写回 options.fields', async () => {
    const { session } = mountModal()
    session.decoder.id = 'field'
    await nextTick()
    expect(modalEl().textContent ?? '').toContain('字段布局')
    const fields = (session.decoder.options as unknown as FieldDecoderOptions).fields
    const before = fields.length

    clickModalButton('添加字段')
    await nextTick()
    expect(fields.length).toBe(before + 1)

    clickModalButton('删除')
    await nextTick()
    expect(fields.length).toBe(before)
  })

  it('切回无（id 置空）→ 字段编辑器隐藏', async () => {
    const { session } = mountModal()
    session.decoder.id = 'field'
    await nextTick()
    expect(modalEl().textContent ?? '').toContain('字段布局')

    session.decoder.id = ''
    await nextTick()
    expect(modalEl().textContent ?? '').not.toContain('字段布局')
  })

  it('解码器切换为 Modbus RTU 时显示协议提示', async () => {
    const { session } = mountModal()
    session.decoder.id = 'modbus-rtu'
    await nextTick()
    expect(modalEl().textContent ?? '').toContain('Modbus RTU')
  })
})
