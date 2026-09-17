import { describe, it, expect, vi } from 'vitest'
import type { Session } from '@/session'
import type { DataMode, LineEnding, Encoding, ChecksumAlgorithm } from '@/types'
import { createMcpToolRegistry, type McpToolContext } from './registry'
import { createSessionRegistry } from './session-registry'
import type { McpSessionRegistry } from './session-registry'

/** 构造 registry 可用的最小会话（仅实现 handler 触达的字段，其余 cast）。 */
function makeSession(over: {
  id?: number
  selectedPort?: string | null
  connected?: boolean
  driverType?: string
  ports?: Array<{ path: string; busy?: boolean }>
  frames?: import('@/types').Message[]
  history?: number[][]
  textLabels?: string[]
} = {}): Session {
  const serial = {
    ports: over.ports ?? [{ path: '/dev/cu.test', busy: false }],
    selectedPort: over.selectedPort ?? null,
    connected: over.connected ?? false,
    driverType: over.driverType ?? 'serialport',
    tcpOptions: { host: '', port: null },
    options: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    refreshPorts: vi.fn(async () => {}),
    connect: vi.fn(async () => {
      serial.connected = true
    }),
    disconnect: vi.fn(async () => {
      serial.connected = false
    }),
    sendRaw: vi.fn(async (_bytes: Uint8Array) => ({ ok: true })),
    send: vi.fn(
      async (_payload: string, _mode: DataMode, _ending: LineEnding, _encoding: Encoding, _checksum?: ChecksumAlgorithm) =>
        ({ ok: true })
    )
  }
  const messages = {
    messages: over.frames ?? [],
    rxFrames: 12,
    txFrames: 3,
    rxErrorFrames: 1,
    droppedFrames: 2,
    paused: false,
    clear: vi.fn(() => {
      messages.messages = []
    })
  }
  const waveform = {
    history: over.history ?? [[], [], []],
    textLabels: over.textLabels ?? []
  }
  return {
    id: over.id ?? 1,
    serial,
    messages,
    waveform,
    dashboard: { latestFields: {}, lastFrame: null },
    checksum: { send: 'none' },
    decoder: { id: '' },
    settings: { encoding: 'utf-8', bufferLimit: 5000 }
  } as unknown as Session
}

function setup(over: { sessions?: McpSessionRegistry; commands?: McpToolContext['commands'] } = {}) {
  const sessions = over.sessions ?? createSessionRegistry()
  const commands = over.commands ?? {
    list: () => [],
    nextSeq: () => 1
  }
  const registry = createMcpToolRegistry({ sessions, commands })
  return { registry, sessions, commands }
}

const enc = new TextEncoder()
function frame(id: number, direction: 'rx' | 'tx', text: string): import('@/types').Message {
  return { id, direction, bytes: enc.encode(text), timestamp: 1000 + id }
}

describe('MCP 工具注册表', () => {
  it('未知工具抛错（桥层映射为工具错误）', async () => {
    const { registry } = setup()
    await expect(registry.handle('nope', {})).rejects.toThrow('未知工具')
  })

  it('list_serial_ports 返回会话枚举的端口并刷新', async () => {
    const sessions = createSessionRegistry()
    const s = makeSession({ ports: [{ path: '/dev/cu.a' }, { path: '/dev/cu.b', busy: true }] })
    sessions.register(s)
    const { registry } = setup({ sessions })
    const r = (await registry.handle('list_serial_ports', {})) as { ports: unknown[] }
    expect(s.serial.refreshPorts).toHaveBeenCalled()
    expect(r.ports).toHaveLength(2)
  })

  it('list_sessions 输出 id/连接态/统计/缓冲占用', async () => {
    const sessions = createSessionRegistry()
    sessions.register(makeSession({ id: 7, selectedPort: '/dev/cu.a', connected: true }))
    const { registry } = setup({ sessions })
    const r = (await registry.handle('list_sessions', {})) as {
      sessions: Array<{ id: number; port: string | null; connected: boolean; stats: { rxFrames: number } }>
    }
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]).toMatchObject({
      id: 7,
      port: '/dev/cu.a',
      connected: true,
      transport: 'serialport',
      stats: { rxFrames: 12 }
    })
  })

  it('不存在的 sessionId 抛明确错误', async () => {
    const { registry } = setup()
    await expect(registry.handle('get_session_status', { sessionId: 99 })).rejects.toThrow('会话 99 不存在')
  })

  describe('connect_serial / disconnect', () => {
    it('成功连接：选中端口 + 调用 connect', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession()
      sessions.register(s)
      const { registry } = setup({ sessions })
      const r = (await registry.handle('connect_serial', { sessionId: 1, port: '/dev/cu.test' })) as {
        ok: boolean
        port: string
      }
      expect(s.serial.selectedPort).toBe('/dev/cu.test')
      expect(s.serial.connect).toHaveBeenCalled()
      expect(r.ok).toBe(true)
    })

    it('已连接时拒绝重复连接', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ connected: true, selectedPort: '/dev/cu.test' }))
      const { registry } = setup({ sessions })
      await expect(registry.handle('connect_serial', { sessionId: 1, port: '/dev/cu.test' })).rejects.toThrow('已连接')
    })

    it('端口不在枚举列表时报错', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ ports: [{ path: '/dev/cu.other' }] }))
      const { registry } = setup({ sessions })
      await expect(registry.handle('connect_serial', { sessionId: 1, port: '/dev/cu.missing' })).rejects.toThrow('端口不存在')
    })

    it('confirmConnect 拒绝时操作被取消', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession())
      const confirm = vi.fn(async () => false)
      const registry = createMcpToolRegistry({ sessions, commands: setup({ sessions }).commands, confirmConnect: confirm })
      await expect(registry.handle('connect_serial', { sessionId: 1, port: '/dev/cu.test' })).rejects.toThrow('连接被用户取消')
      expect(confirm).toHaveBeenCalledWith('/dev/cu.test', 'connect')
    })

    it('disconnect 未连接时报错', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ connected: false }))
      const { registry } = setup({ sessions })
      await expect(registry.handle('disconnect', { sessionId: 1 })).rejects.toThrow('未连接')
    })

    it('disconnect 成功断开', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession({ connected: true, selectedPort: '/dev/cu.test' })
      sessions.register(s)
      const { registry } = setup({ sessions })
      const r = (await registry.handle('disconnect', { sessionId: 1 })) as { ok: boolean }
      expect(r.ok).toBe(true)
      expect(s.serial.disconnect).toHaveBeenCalled()
    })
  })

  describe('发送', () => {
    it('send_string 按会话编码与默认校验走 serial.send', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession({ connected: true })
      sessions.register(s)
      const { registry } = setup({ sessions })
      await registry.handle('send_string', { sessionId: 1, text: 'AT\r', lineEnding: 'cr' })
      expect(s.serial.send).toHaveBeenCalledWith('AT\r', 'ascii', 'cr', 'utf-8', 'none')
    })

    it('send_bytes 原样送字节', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession({ connected: true })
      sessions.register(s)
      const { registry } = setup({ sessions })
      const r = (await registry.handle('send_bytes', { sessionId: 1, data: [0xaa, 0x55] })) as { sent_bytes: number }
      expect(r.sent_bytes).toBe(2)
      expect(s.serial.sendRaw).toHaveBeenCalledWith(new Uint8Array([0xaa, 0x55]))
    })

    it('run_quick_command 展开占位符并按 inherit 解析行尾/校验和', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession({ connected: true })
      s.checksum.send = 'crc16-modbus' as never
      sessions.register(s)
      const commands: McpToolContext['commands'] = {
        list: () => [
          {
            id: 'c1',
            name: '校时',
            payload: 'SET_TIME={time:full}',
            mode: 'ascii',
            appendNewline: 'inherit',
            checksum: 'inherit'
          } as never
        ],
        nextSeq: vi.fn(() => 3)
      }
      const { registry } = setup({ sessions, commands })
      const r = (await registry.handle('run_quick_command', { sessionId: 1, commandIdOrName: '校时' })) as {
        command: string
      }
      expect(commands.nextSeq).toHaveBeenCalledWith('c1')
      const calls = (s.serial.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      const call = calls[0] as [string, string, string, string, string]
      const [payload, mode, ending, , cs] = call
      expect(payload).toMatch(/^SET_TIME=\d{4}-\d{2}-\d{2}/)
      expect(mode).toBe('ascii')
      expect(ending).toBe('crlf')
      expect(cs).toBe('crc16-modbus')
      expect(r.command).toBe('校时')
    })
  })

  describe('读取', () => {
    it('get_recent_messages 倒序返回、方向过滤、附带 hex', async () => {
      const sessions = createSessionRegistry()
      sessions.register(
        makeSession({ frames: [frame(1, 'rx', 'hello'), frame(2, 'tx', 'ACK'), frame(3, 'rx', 'world')] })
      )
      const { registry } = setup({ sessions })
      const r = (await registry.handle('get_recent_messages', { sessionId: 1, mode: 'hex' })) as {
        frames: Array<{ id: number; direction: string; hex: string }>
      }
      expect(r.frames.map((f) => f.id)).toEqual([3, 2, 1])
      expect(r.frames[0].direction).toBe('rx')
      expect(r.frames[0].hex).toBe('77 6F 72 6C 64')

      const rx = (await registry.handle('get_recent_messages', {
        sessionId: 1,
        filter: { direction: 'tx' }
      })) as { frames: Array<{ id: number }> }
      expect(rx.frames.map((f) => f.id)).toEqual([2])
    })

    it('通过 filter.text 过滤帧', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ frames: [frame(1, 'rx', 'hello world'), frame(2, 'rx', 'goodbye')] }))
      const { registry } = setup({ sessions })
      const r = (await registry.handle('get_recent_messages', {
        sessionId: 1,
        filter: { text: 'world' }
      })) as { frames: Array<{ id: number }> }
      expect(r.frames.map((f) => f.id)).toEqual([1])
    })

    it('search_messages 按文本/方向搜索', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ frames: [frame(1, 'rx', 'hello'), frame(2, 'tx', 'hello'), frame(3, 'rx', 'bye')] }))
      const { registry } = setup({ sessions })
      const r = (await registry.handle('search_messages', { sessionId: 1, query: 'hello' })) as {
        hits: Array<{ id: number }>
      }
      expect(r.hits.map((f) => f.id)).toEqual([2, 1])
    })

    it('get_waveform recent 取尾部 N 点', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession({ history: [[1, 2, 3, 4, 5], [10, 20, 30, 40, 50], [1, 1, 1, 1, 1]], textLabels: ['ch1'] }))
      const { registry } = setup({ sessions })
      const r = (await registry.handle('get_waveform', { sessionId: 1, recent: 2 })) as {
        xs: number[]
        series: number[][]
        channels: string[]
      }
      expect(r.xs).toEqual([4, 5])
      expect(r.series[0]).toEqual([40, 50])
      // 通道按 history 实际形状补齐：label 只有 ch1，其余按序号命名
      expect(r.channels).toEqual(['ch1', 'CH2', 'CH3', 'CH4'])
    })

    it('get_waveform 无数据返回空结构', async () => {
      const sessions = createSessionRegistry()
      sessions.register(makeSession())
      const { registry } = setup({ sessions })
      const r = (await registry.handle('get_waveform', { sessionId: 1 })) as { xs: number[] }
      expect(r.xs).toEqual([])
    })
  })

  describe('会话控制', () => {
    it('set_paused / clear_messages', async () => {
      const sessions = createSessionRegistry()
      const s = makeSession({ frames: [frame(1, 'rx', 'a')] })
      sessions.register(s)
      const { registry } = setup({ sessions })

      const r = (await registry.handle('set_paused', { sessionId: 1, paused: true })) as { paused: boolean }
      expect(r.paused).toBe(true)

      await registry.handle('clear_messages', { sessionId: 1 })
      expect(s.messages.messages).toHaveLength(0)
      expect(s.messages.clear).toHaveBeenCalled()
    })
  })
})