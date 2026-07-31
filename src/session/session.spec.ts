import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSession } from '@/session'
import { setDriverType, createSerialDriver } from '@/serial'
import { MockSerialSource } from '@/mock/MockSerialSource'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  setActivePinia(createPinia())
  setDriverType('mock')
})

/** 注入一行波形文本并等待 gap-timeout 帧关闭 + rAF 刷入 */
async function injectLine(line: string) {
  const mock = createSerialDriver() as MockSerialSource
  mock.inject(new TextEncoder().encode(line))
  await sleep(50) // gapMs(20) 帧关闭 + rAF 批处理
}

describe('createSession · 会话接线', () => {
  it('串口数据流 → 消息列表 + 波形（同一份字节被两个消费者处理）', async () => {
    const session = createSession()

    await session.serial.refreshPorts()
    await session.serial.connect()
    expect(session.serial.connected.value).toBe(true)

    // createSerialDriver() 返回与会话内同一实例（模块级缓存），直接注入数据
    await injectLine('1,2\n')
    await injectLine('3,4\n')

    // gap-timeout 切分会把行尾 \n 保留在帧里（文档化行为）
    const texts = session.messages.messages.value.map((m) => new TextDecoder().decode(m.bytes))
    expect(texts).toEqual(['1,2\n', '3,4\n'])
    expect(session.waveform.history.value[0].length).toBe(2)

    await session.serial.disconnect()
  })

  it('pause.clearAll 同时清空消息与波形（循环依赖通过闭包延迟绑定）', async () => {
    const session = createSession()

    await session.serial.refreshPorts()
    await session.serial.connect()
    await injectLine('1,2\n')
    await injectLine('3,4\n')

    expect(session.messages.messages.value.length).toBe(2)
    expect(session.waveform.history.value[0].length).toBe(2)

    session.pause.clearAll()
    expect(session.messages.messages.value.length).toBe(0)
    expect(session.waveform.history.value[0].length).toBe(0)

    await session.serial.disconnect()
  })

  it('每个会话的 pause 状态彼此独立（多会话互不干扰）', () => {
    const a = createSession()
    const b = createSession()
    expect(a.pause.paused.value).toBe(false)
    expect(b.pause.paused.value).toBe(false)
    a.pause.toggle()
    expect(a.pause.paused.value).toBe(true)
    expect(b.pause.paused.value).toBe(false)
  })
})
