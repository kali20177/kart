// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { McpServer, type McpBridge } from './McpServer'
import { MCP_TOOLS } from '../mcp/contract'

const PROTOCOL_VERSION = '2025-06-18'

/** 真实 streamable-http 客户端助手：会话初始化 + 后续请求（自动带 session id）。 */
class McpTestClient {
  private sid: string | null = null
  private seq = 0
  constructor(
    private readonly port: number,
    private readonly token: string
  ) {}
  private async post(body: unknown, sid = this.sid): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      // streamable-http 规范：客户端须声明同时接受 JSON 与 SSE 两种响应媒体
      accept: 'application/json, text/event-stream',
    }
    if (sid) headers['mcp-session-id'] = sid
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (process.env.MCP_DEBUG) {
      console.error('POST', res.status, res.headers.get('content-type'), 'BODY:', text.slice(0, 300))
    }
    const json = (text ? (JSON.parse(text) as Record<string, unknown>) : {}) as Record<string, unknown>
    const newSid = res.headers.get('mcp-session-id')
    if (newSid) this.sid = newSid
    return { status: res.status, json }
  }
  async initialize(): Promise<void> {
    const { json } = await this.post({
      jsonrpc: '2.0',
      id: this.seq++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'jest', version: '1' },
      },
    })
    expect(json.result).toBeDefined()
    if (!this.sid) {
      // 诊断：打印真实响应方便调试协议问题
      console.error('INIT FAIL JSON:', JSON.stringify(json))
      throw new Error('initialize 未返回 mcp-session-id')
    }
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  async listTools(): Promise<Array<{ name: string }>> {
    const { json } = await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'tools/list' })
    return (json.result as { tools: Array<{ name: string }> }).tools
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<{
    isError?: boolean
    text?: string
  }> {
    const { json } = await this.post({
      jsonrpc: '2.0',
      id: this.seq++,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    const r = json.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    return { isError: r?.isError, text: r?.content?.[0]?.text }
  }
}

async function startServer(mode: 'read-write' | 'read-only', bridge?: McpBridge) {
  const server = new McpServer(
    bridge ?? { invoke: async (tool, args) => ({ echoed: tool, args }) },
    () => {}
  )
  const port = await server.start(0, 'test-token', mode) // port 0 → 系统分配
  return { server, port, client: new McpTestClient(port, 'test-token') }
}

const running: McpServer[] = []
async function startServerTracked(mode: 'read-write' | 'read-only', bridge?: McpBridge) {
  const { server, ...rest } = await startServer(mode, bridge)
  running.push(server)
  return { server, ...rest }
}

afterEach(() => {
  for (const s of running.splice(0)) s.stop()
})

describe('McpServer（streamable-http 集成）', () => {
  it('list_tools 返回契约全量工具（不经桥）', async () => {
    const { client } = await startServerTracked('read-write')
    await client.initialize()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort())
  })

  it('缺 token / 错 token 一律 401', async () => {
    const { server, port } = await startServer('read-write')
    running.push(server)
    const cases: Array<Record<string, string>> = [
      { 'content-type': 'application/json' },
      { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    ]
    for (const headers of cases) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
      expect(res.status).toBe(401)
    }
  })

  it('call_tool 经桥转发并回传 JSON 结果', async () => {
    const bridge: McpBridge = { invoke: vi.fn(async (tool, args) => ({ tool, args, done: true })) }
    const { client } = await startServerTracked('read-write', bridge)
    await client.initialize()
    const r = await client.callTool('send_string', { sessionId: 1, text: 'hi' })
    expect(r.isError).not.toBe(true)
    // SDK zod default 会补齐缺省参数（lineEnding 默认 none）；核心断言 bridge 收到调用
    const echoed = JSON.parse(r.text ?? '{}') as { tool: string; args: { sessionId: number; text: string } }
    expect(echoed.tool).toBe('send_string')
    expect(echoed.args.sessionId).toBe(1)
    expect(echoed.args.text).toBe('hi')
    expect(bridge.invoke).toHaveBeenCalledWith('send_string', {
      sessionId: 1,
      text: 'hi',
      lineEnding: 'none',
    })
  })

  it('read-only 模式拒绝写工具且不触桥；读工具放行', async () => {
    const bridge: McpBridge = { invoke: vi.fn(async () => ({ ok: true })) }
    const { client } = await startServerTracked('read-only', bridge)
    await client.initialize()

    const w = await client.callTool('send_string', { sessionId: 1, text: 'x' })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('permission denied')
    expect(bridge.invoke).not.toHaveBeenCalled()

    const r = await client.callTool('list_sessions', {})
    expect(r.isError).not.toBe(true)
    expect(bridge.invoke).toHaveBeenCalledWith('list_sessions', {})
  })

  it('工具内部抛错映射为 isError，bridge 异常同样上报', async () => {
    const bridge: McpBridge = {
      invoke: async () => {
        throw new Error('会话 99 不存在')
      },
    }
    const { client } = await startServerTracked('read-write', bridge)
    await client.initialize()
    const r = await client.callTool('send_bytes', { sessionId: 99, data: [1] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('会话 99 不存在')
  })

  it('未知工具返回 isError', async () => {
    const { client } = await startServerTracked('read-write')
    await client.initialize()
    const r = await client.callTool('no_such_tool', {})
    expect(r.isError ?? r.text).toBeTruthy()
  })

  it('start 幂等：运行中重复 start 返回原端口', async () => {
    const { server, port } = await startServer('read-write')
    running.push(server)
    const again = await server.start(9999, 'x', 'read-write')
    expect(again).toBe(port)
  })

  it('stop 后端口释放（连接被拒绝）', async () => {
    const { server, port, client } = await startServer('read-write')
    await client.initialize()
    server.stop()
    expect(server.getStatus().running).toBe(false)
    // server.close() 后监听 socket 关闭 → 新连接直接 RST/拒绝（非 401）
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      })
    ).rejects.toThrow()
  })
})