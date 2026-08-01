import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSession, type Session } from '@/session'
import { setDriverType } from '@/serial'
import { MockSerialSource } from '@/mock/MockSerialSource'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 每个测试创建的会话，afterEach 统一 dispose 清理（定时器/订阅/驱动）
let sessions: Session[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  setDriverType('mock')
  sessions = []
})

afterEach(() => {
  for (const s of sessions) s.dispose()
  sessions = []
})

/** 创建注入指定 mock 驱动的会话，并登记到 sessions 列表 */
function makeSession(mock: MockSerialSource): Session {
  const session = createSession({ createDriver: () => mock })
  sessions.push(session)
  return session
}

/** 注入一行波形文本并等待 gap-timeout 帧关闭 + rAF 刷入 */
async function injectLine(mock: MockSerialSource, line: string) {
  mock.inject(new TextEncoder().encode(line))
  await sleep(50) // gapMs(20) 帧关闭 + rAF 批处理
}

describe('createSession · 会话接线', () => {
  it('串口数据流 → 消息列表 + 波形（同一份字节被两个消费者处理）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)

    await session.serial.refreshPorts()
    await session.serial.connect()
    expect(session.serial.connected).toBe(true)

    // 数据注入走注入的 mock 实例
    await injectLine(mock, '1,2\n')
    await injectLine(mock, '3,4\n')

    // gap-timeout 切分会把行尾 \n 保留在帧里（文档化行为）
    const texts = session.messages.messages.map((m) => new TextDecoder().decode(m.bytes))
    expect(texts).toEqual(['1,2\n', '3,4\n'])
    expect(session.waveform.history[0].length).toBe(2)

    await session.serial.disconnect()
  })

  it('pause.clearAll 同时清空消息与波形（循环依赖通过闭包延迟绑定）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)

    await session.serial.refreshPorts()
    await session.serial.connect()
    await injectLine(mock, '1,2\n')
    await injectLine(mock, '3,4\n')

    expect(session.messages.messages.length).toBe(2)
    expect(session.waveform.history[0].length).toBe(2)

    session.pause.clearAll()
    expect(session.messages.messages.length).toBe(0)
    expect(session.waveform.history[0].length).toBe(0)

    await session.serial.disconnect()
  })

  it('每个会话的 pause 状态彼此独立（多会话互不干扰）', () => {
    const a = makeSession(new MockSerialSource())
    const b = makeSession(new MockSerialSource())
    expect(a.pause.paused).toBe(false)
    expect(b.pause.paused).toBe(false)
    a.pause.toggle()
    expect(a.pause.paused).toBe(true)
    expect(b.pause.paused).toBe(false)
  })

  it('dispose 停止 session 内定时器（信号轮询不再触发）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)

    await session.serial.refreshPorts()
    await session.serial.connect()
    expect(session.serial.connected).toBe(true)

    // dispose 后连接被关闭、驱动被清理
    session.dispose()
    expect(mock.isOpen).toBe(false)
  })
})
