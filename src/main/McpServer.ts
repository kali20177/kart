import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_TOOLS, type McpToolDef } from '../mcp/contract'

/** MCP 授权模式（与 settings.mcp.mode 对齐）。 */
export type McpMode = 'off' | 'read-only' | 'read-write'

/**
 * 桥接层——把 MCP call_tool 转发到渲染进程的工具注册表执行。
 * 主进程不持有会话数据面（数据在渲染进程 stores），仅经此接口请求执行
 * 并拿回 JSON 结果；超时由实现方（main/index.ts 的 McpBridge）负责，
 * 本类只依赖接口（docs/mcp-design.md §八）。
 */
export interface McpBridge {
  invoke(tool: string, args: unknown): Promise<unknown>
}

/** 运行状态快照（渲染端 UI 展示用；token 本机可信，允许回传）。 */
export interface McpServerStatus {
  running: boolean
  port: number | null
  token: string | null
  mode: McpMode
}

const TOOL_CALL_TIMEOUT_MS = 15_000

/**
 * 入站 MCP 服务器（streamable-http，仅绑 127.0.0.1）。
 *
 * - 鉴权：除 DELETE 外每个请求都校验 `Authorization: Bearer <token>`，失败 401；
 * - 工具路由：list_tools 直接由共享契约表应答；call_tool 按 mode 做读写 gate
 *   后经 bridge 转发渲染进程执行，15s 超时（Lissio ai_tool_resolve 同款时限）；
 * - 会话管理：stateful streamable-http（sessionIdGenerator + transports 表），
 *   enableJsonResponse 优先 JSON 响应（curl/调试友好），客户端要流式才起 SSE。
 *
 * 与 Electron 解耦（桥/日志注入），可在 vitest node 环境直接起真实 server 集成测试。
 */
export class McpServer {
  private sdk: SdkMcpServer | null = null
  private httpServer: http.Server | null = null
  private transports = new Map<string, StreamableHTTPServerTransport>()
  private token: string | null = null
  private mode: McpMode = 'read-write'
  private port: number | null = null

  constructor(
    private readonly bridge: McpBridge,
    private readonly log: (msg: string) => void = (m) => console.log(`[mcp] ${m}`),
    /** 工具调用超时（测试注入短值验证超时路径；生产默认 15s） */
    private readonly toolTimeoutMs: number = TOOL_CALL_TIMEOUT_MS
  ) {}

  /**
   * 在 127.0.0.1:{port} 启动 server，返回实际绑定端口。
   * token 为空时自动生成每次启动随机 token（不落盘，重启作废）。
   * start/stop 幂等：运行中重复 start 返回当前端口；参数变化时先 stop 再 start。
   */
  async start(port: number, token: string | null, mode: McpMode): Promise<number> {
    if (this.httpServer) return this.port ?? port

    this.token = token?.trim() || randomUUID().replaceAll('-', '').slice(0, 32)
    this.mode = mode
    const sdk = new SdkMcpServer(
      { name: 'kart', version: '0.1.0' },
      { capabilities: { tools: {} } }
    )
    for (const def of MCP_TOOLS) {
      sdk.registerTool(
        def.name,
        {
          title: def.name,
          description: def.description,
          inputSchema: def.inputSchema
        },
        async (args) => this.handleToolCall(def, args)
      )
    }
    this.sdk = sdk

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res)
    })
    // 仅监听 loopback：不暴露到局域网（docs/mcp-design.md §D2）
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.httpServer = server
    this.port = (server.address() as { port: number }).port
    this.log(`server started: http://127.0.0.1:${this.port}/mcp (mode=${mode})`)
    return this.port
  }

  /** 优雅停止（幂等）：关 HTTP 服务、断开会话、释放 SDK 实例。 */
  stop(): void {
    if (!this.httpServer) return
    this.log(`server stopped (was :${this.port})`)
    this.httpServer.close()
    this.httpServer = null
    this.port = null
    this.sdk = null
    this.transports.clear()
    this.token = null
  }

  getStatus(): McpServerStatus {
    return {
      running: this.httpServer !== null,
      port: this.port,
      token: this.token,
      mode: this.mode
    }
  }

  // ── HTTP 层：鉴权 + streamable-http 路由 ────────────────

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 鉴权（DELETE 会话关闭也要求 token——只有持 token 的客户端才能关会话）
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized: missing or invalid Bearer token' }))
      return
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `method not allowed: ${req.method}` }))
      return
    }

    const body = await readBody(req)
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'POST' && !sessionId) {
      // 新会话：POST 且无 session-id（通常是 initialize）
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          this.transports.set(sid, transport)
          this.log(`session initialized: ${sid}`)
        },
        enableJsonResponse: true
      })
      if (this.sdk) await this.sdk.connect(transport)
      await transport.handleRequest(req, res, body)
    } else if (sessionId) {
      const transport = this.transports.get(sessionId)
      if (!transport) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `unknown session: ${sessionId}` }))
        return
      }
      if (req.method === 'DELETE') {
        this.transports.delete(sessionId)
        this.log(`session closed: ${sessionId}`)
      }
      await transport.handleRequest(req, res, body)
    } else {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing mcp-session-id header' }))
    }
  }

  // ── 工具层：读写 gate + 桥转发 ─────────────────────────

  private async handleToolCall(
    def: McpToolDef,
    args: unknown
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    if (def.write && this.mode !== 'read-write') {
      return {
        content: [{ type: 'text', text: `permission denied: 工具 ${def.name} 为写操作，当前为只读模式` }],
        isError: true
      }
    }
    try {
      const result = await Promise.race([
        this.bridge.invoke(def.name, args ?? {}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`tool timeout after ${this.toolTimeoutMs}ms`)), this.toolTimeoutMs)
        )
      ])
      this.log(`tool ok: ${def.name}`)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`tool error: ${def.name}: ${msg}`)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
  }
}

/** 读取请求体（POST 负载）；GET/DELETE 无体直接返回 undefined。 */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    if (req.method !== 'POST') {
      resolve(undefined)
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      const raw = Buffer.concat(chunks).toString('utf-8')
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}