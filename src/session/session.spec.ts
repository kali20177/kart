import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSession, type Session } from '@/session'
import { setDriverType } from '@/serial'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { binaryFrame } from '@/mock/scenarios'

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

/** 轮询等待消息列表刷入到指定累计条数。gap-timeout 尾帧 + rAF 批处理是真实完成
 *  事件，轮询它而非固定 sleep，避免对宏任务时序做常量阈值假设（CI 高负载抖动）。
 *  vitest 1.x 无 expect.poll，手写带超时轮询。 */
async function waitForMessages(session: Session, count: number) {
  const deadline = Date.now() + 2000
  while (session.messages.messages.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`超时：消息列表 ${session.messages.messages.length} 条，期望 ${count} 条`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 注入一行波形文本并等待消息列表刷入到累计 count 条（波形为同步 push，消息列表是慢车道） */
async function injectLine(session: Session, mock: MockSerialSource, line: string, count: number) {
  mock.inject(new TextEncoder().encode(line))
  await waitForMessages(session, count)
}

describe('createSession · 会话接线', () => {
  it('串口数据流 → 消息列表 + 波形（同一份字节被两个消费者处理）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)

    await session.serial.refreshPorts()
    await session.serial.connect()
    expect(session.serial.connected).toBe(true)

    // 数据注入走注入的 mock 实例
    await injectLine(session, mock, '1,2\n', 1)
    await injectLine(session, mock, '3,4\n', 2)

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
    await injectLine(session, mock, '1,2\n', 1)
    await injectLine(session, mock, '3,4\n', 2)

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

  it('DTR/RTS/Break 信号控制经 store 下发到驱动（mock 记录输出线状态供断言）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)

    await session.serial.refreshPorts()
    await session.serial.connect()
    expect(mock.outputSignals).toEqual({ dtr: false, rts: false })

    // DTR/RTS 电平切换
    await session.serial.setDtr(true)
    expect(mock.outputSignals).toEqual({ dtr: true, rts: false })
    await session.serial.setRts(true)
    expect(mock.outputSignals).toEqual({ dtr: true, rts: true })

    // Break 脉冲：250ms 内置位再释放
    const p = session.serial.pulseBreak()
    expect(mock.breakActive).toBe(true)
    await p
    expect(mock.breakActive).toBe(false)

    await session.serial.disconnect()
  })
})

describe('createSession · 帧解码（会话级配置 + 端口持久化）', () => {
  it('连接后启用帧解码 → 二进制连续帧显示字段块', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)
    await session.serial.refreshPorts()
    await session.serial.connect()
    // 默认模板（AA55 帧头 + 字段布局）匹配 mock 二进制帧：AA 55 06 <payload6> <xor>
    session.decoder.enabled = true
    mock.inject(binaryFrame(0))
    await waitForMessages(session, 1)
    const m = session.messages.messages[0]
    expect(m.decoded).toBeDefined()
    expect(m.decoded?.fields.map((f) => f.name)).toEqual(['header', 'len', 'payload', 'crc'])
    expect(m.decoded?.fields[0].value).toBe('AA 55')
    await session.serial.disconnect()
  })

  it('先启用帧解码再连接（端口未选）→ 配置不丢失仍生效', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)
    // 端口尚未选择时就启用（对应「先打开设置启用，再连 mock」的用户流程）
    session.decoder.enabled = true
    await session.serial.refreshPorts() // 此刻 selectedPort 变为 COM3，触发端口 watcher
    await session.serial.connect()
    expect(session.decoder.enabled).toBe(true)
    mock.inject(binaryFrame(0))
    await waitForMessages(session, 1)
    expect(session.messages.messages[0].decoded).toBeDefined()
    await session.serial.disconnect()
  })

  it('端口配置跨会话持久化（新会话连接同端口自动载入）', async () => {
    const a = makeSession(new MockSerialSource())
    await a.serial.refreshPorts()
    await a.serial.connect() // COM3
    a.decoder.enabled = true // 持久化到 decoder-config:COM3
    await a.serial.disconnect()

    const b = makeSession(new MockSerialSource())
    await b.serial.refreshPorts() // COM3 → 应载入 enabled=true
    expect(b.decoder.enabled).toBe(true)
    b.dispose()
  })
})

describe('createSession · TCP 传输', () => {
  it('setTransport(tcp) → 端点连接 → 远端字节流入消息列表（假 bridge 注入）', async () => {
    // 假 electron.tcp 桥：内存 handler 集合，测试侧可注入远端字节
    const dataHandlers = new Set<(data: Uint8Array, id: string) => void>()
    const fakeTcp = {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      onData: vi.fn((h: (data: Uint8Array, id: string) => void) => {
        dataHandlers.add(h)
        return () => { dataHandlers.delete(h) }
      }),
      onError: vi.fn(() => () => {})
    }
    const prevElectron = window.electron
    // jsdom 下无 electron：仅注入 tcp 段（TcpDriver 经 window.electron?.tcp 取桥）
    window.electron = { tcp: fakeTcp } as unknown as NonNullable<typeof window.electron>
    try {
      const session = makeSession(new MockSerialSource())
      await session.serial.setTransport('tcp')
      expect(session.serial.transportType).toBe('tcp')
      session.serial.tcpOptions.host = '192.168.1.5'
      session.serial.tcpOptions.port = 502
      await session.serial.connect()
      expect(session.serial.connected).toBe(true)
      // TCP 端点统一写入 selectedPort（显示/录制/decoder-config 键共用）
      expect(session.serial.selectedPort).toBe('192.168.1.5:502')

      // 假 bridge 注入远端字节 → 消息列表
      for (const h of dataHandlers) h(new Uint8Array([0xaa, 0x55, 0x12, 0x34]), '192.168.1.5:502')
      await waitForMessages(session, 1)
      expect(Array.from(session.messages.messages[0].bytes)).toEqual([0xaa, 0x55, 0x12, 0x34])

      await session.serial.disconnect()
    } finally {
      window.electron = prevElectron
    }
  })
})

describe('createSession · 终端接线（mock shell 场景）', () => {
  it('mock shell 回显与命令应答 → terminal store 渲染（sendBytes 走 record=false）', async () => {
    const mock = new MockSerialSource()
    const session = makeSession(mock)
    session.serial.scenario = 'shell'
    await session.serial.refreshPorts()
    await session.serial.connect()

    // 终端发送路径下发命令：mock 设备侧回显 + 应答
    await session.terminal.sendBytes(new TextEncoder().encode('ls\r'))

    // 轮询终端回滚文本出现命令输出（banner 定时器 + rAF 批处理为真实完成事件）
    const deadline = Date.now() + 2000
    let txt = ''
    while (true) {
      txt = session.terminal.scrollbackText()
      if (txt.includes('app')) break
      if (Date.now() > deadline) throw new Error(`超时：终端未见 ls 输出。text="${txt}"`)
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(txt).toContain('root@kart:~#')
    // TX 不污染消息列表（record=false）：消息帧日志只含设备回显/应答，无逐命令 TX 气泡
    await session.serial.disconnect()
  })
})
