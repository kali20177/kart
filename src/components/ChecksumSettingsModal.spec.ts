import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import ChecksumSettingsModal from './ChecksumSettingsModal.vue'
import { createSession, type Session } from '@/session'
import { provideSession } from '@/composables/useSession'
import { i18n } from '@/i18n'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { setDriverType } from '@/serial'

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
      return () => h(NMessageProvider, null, { default: () => h(ChecksumSettingsModal, { show: true }) })
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

describe('ChecksumSettingsModal · 会话级校验和配置', () => {
  it('打开后渲染标题与发送/接收两个下拉，默认「无」', async () => {
    mountModal()
    const text = modalEl().textContent ?? ''
    expect(text).toContain('校验和')
    expect(text).toContain('发送校验和')
    expect(text).toContain('接收校验算法')
    expect(text).toContain('无')
  })

  it('直接编辑 session.checksum 同一 reactive 对象 → 弹窗下拉选中态实时跟随', async () => {
    const { session } = mountModal()
    expect(session.checksum.send).toBe('none')
    expect(session.checksum.rx).toBe('none')

    session.checksum.send = 'sum8'
    session.checksum.rx = 'crc16-modbus'
    await nextTick()
    const text = modalEl().textContent ?? ''
    expect(text).toContain('SUM8')
    expect(text).toContain('CRC16-Modbus')
  })
})
