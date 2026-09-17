import type { Message, QuickCommand } from '@/types'
import type { DecodeInfo } from '@/decoders/types'
import { bytesToHex } from '@/utils/hex'
import { decodeBytes } from '@/utils/encoding'
import { expandCommandVars } from '@/utils/command-vars'
import type { McpSessionRegistry } from './session-registry'
import { MCP_TOOLS } from './contract'

/**
 * MCP 工具执行上下文——渲染端依赖注入（docs/mcp-design.md §八）。
 * commands 与 confirmConnect 在 App.vue 组装时注入：pinia store 只能在
 * 运行时（setup 内）调用，模块级顶层取会崩（见 src/stores 顶部陷阱）。
 */
export interface McpToolContext {
  /** 全局会话注册表（App.vue 建会话时注册） */
  sessions: McpSessionRegistry
  /** 快速命令读取（全局 commands store，运行时注入） */
  commands: {
    list(): QuickCommand[]
    nextSeq(id: string): number
  }
  /** AI 连接/断开前的用户确认钩子（settings.mcp.confirmConnect）；缺省放行 */
  confirmConnect?: (port: string, action: 'connect' | 'disconnect') => Promise<boolean>
}

/** 工具调用统一错误：Message 带 sessionId 上下文。 */
class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** 按 sessionId 解析会话；不存在抛明确错误（引导先 list_sessions）。 */
function requireSession(ctx: McpToolContext, sessionId: number): NonNullable<ReturnType<McpSessionRegistry['get']>> {
  const s = ctx.sessions.get(sessionId)
  if (!s) throw new ToolError(`会话 ${sessionId} 不存在（先调用 list_sessions 获取有效 sessionId）`)
  return s
}

/** 帧 → 工具可返回的 JSON 结构（hex/ascii 按需；>4096B 折叠为 512B 预览，与 UI 同语义）。 */
function formatMessage(
  m: Message,
  encoding: 'utf-8' | 'ascii' | 'gbk',
  mode: 'ascii' | 'hex',
  withDecode: boolean
): Record<string, unknown> {
  const MAX_PREVIEW = 512
  const truncated = m.bytes.length > 4096
  const body = truncated ? m.bytes.subarray(0, MAX_PREVIEW) : m.bytes
  const out: Record<string, unknown> = {
    id: m.id,
    direction: m.direction,
    ts: m.timestamp,
    len: m.bytes.length
  }
  if (mode === 'ascii' || mode === 'hex') {
    out.hex = bytesToHex(body)
  }
  if (mode === 'ascii') {
    out.ascii = decodeBytes(body, encoding)
  }
  if (truncated) out.truncated = true
  if (m.note) out.note = m.note
  if (m.error) out.error = m.error
  if (m.checksumFailed) out.checksumFailed = true
  if (withDecode && m.decoded) {
    const d: DecodeInfo = m.decoded
    out.decoded = { decoderId: d.decoderId, summary: d.summary, fields: d.fields }
  }
  return out
}

/** 渲染进程 MCP 工具注册表：单一入口 handle(tool, args)，桥/未来内置 AI 复用同一实现。 */
export interface McpToolRegistry {
  handle(tool: string, args: Record<string, unknown>): Promise<unknown>
}

export function createMcpToolRegistry(ctx: McpToolContext): McpToolRegistry {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    // ── 读 ──────────────────────────────────────────────
    async list_serial_ports() {
      const first = ctx.sessions.list()[0]
      if (!first) return { ports: [] }
      // 刷新一次拿到最新端点（含 busy 探测），失败时退回会话当前列表
      try {
        await first.serial.refreshPorts()
      } catch {
        /* 保留旧列表 */
      }
      return { ports: first.serial.ports }
    },

    async list_sessions() {
      const list = ctx.sessions.list().map((s) => {
        const msgs = s.messages.messages
        const limit = s.settings.bufferLimit
        return {
          id: s.id,
          port: s.serial.selectedPort,
          transport: s.serial.driverType,
          connected: s.serial.connected,
          baudRate: s.serial.options.baudRate,
          paused: s.messages.paused,
          stats: {
            rxFrames: s.messages.rxFrames,
            txFrames: s.messages.txFrames,
            rxErrorFrames: s.messages.rxErrorFrames,
            droppedFrames: s.messages.droppedFrames
          },
          bufferUsage: limit > 0 ? Math.round((msgs.length / limit) * 100) / 100 : 0
        }
      })
      return { sessions: list }
    },

    async get_session_status(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const msgs = s.messages.messages
      const limit = s.settings.bufferLimit
      return {
        sessionId: s.id,
        port: s.serial.selectedPort,
        transport: s.serial.driverType,
        connected: s.serial.connected,
        baudRate: s.serial.options.baudRate,
        encoding: s.settings.encoding,
        frameStrategy: s.settings.frame.strategy,
        bufferLimit: limit,
        bufferUsage: limit > 0 ? Math.round((msgs.length / limit) * 100) / 100 : 0,
        paused: s.messages.paused,
        decoderId: s.decoder.id || '',
        checksumSend: s.checksum.send,
        stats: {
          rxFrames: s.messages.rxFrames,
          txFrames: s.messages.txFrames,
          rxErrorFrames: s.messages.rxErrorFrames,
          droppedFrames: s.messages.droppedFrames
        }
      }
    },

    async get_recent_messages(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const count = Math.min(Math.max(Number(args.count ?? 50), 1), 500)
      const mode = args.mode === 'ascii' ? 'ascii' : 'hex'
      const filter = (args.filter ?? {}) as { direction?: string; text?: string }
      const withDecode = args.decode !== false

      const frames = s.messages.messages
        .filter((m) => m.kind === undefined || m.kind === 'frame')
        .filter((m) => !filter.direction || m.direction === filter.direction)
        .filter((m) => {
          if (!filter.text) return true
          const text = filter.text.toLowerCase()
          return (
            decodeBytes(m.bytes, s.settings.encoding).toLowerCase().includes(text) ||
            bytesToHex(m.bytes, '').toLowerCase().includes(text)
          )
        })
        .slice(-count)
        .reverse()

      return { frames: frames.map((m) => formatMessage(m, s.settings.encoding, mode, withDecode)) }
    },

    async search_messages(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const query = String(args.query ?? '')
      const mode = args.mode === 'hex' ? 'hex' : 'ascii'
      const direction = args.direction as 'rx' | 'tx' | undefined
      const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 100)
      const q = mode === 'hex' ? query.replace(/\s+/g, '').toLowerCase() : query.toLowerCase()

      const hits: Message[] = []
      for (let i = s.messages.messages.length - 1; i >= 0 && hits.length < limit; i--) {
        const m = s.messages.messages[i]
        if (direction && m.direction !== direction) continue
        const target =
          mode === 'hex' ? bytesToHex(m.bytes, '').toLowerCase() : decodeBytes(m.bytes, s.settings.encoding).toLowerCase()
        if (target.includes(q)) hits.push(m)
      }
      return { hits: hits.map((m) => formatMessage(m, s.settings.encoding, mode, true)) }
    },

    async get_waveform(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const history = s.waveform.history
      const xsAll = history[0]
      if (!xsAll || xsAll.length === 0) return { channels: [], xs: [], series: [] }

      const labels = s.waveform.textLabels
      const channels = xsAll.length > 1 ? labels.slice(0, xsAll.length - 1) : []
      while (channels.length < xsAll.length - 1) channels.push(`CH${channels.length + 1}`)

      let startIdx = 0
      let endIdx = xsAll.length
      if (args.recent != null) {
        const n = Math.min(Math.max(Number(args.recent), 1), 5000)
        startIdx = Math.max(0, xsAll.length - n)
      } else if (args.window) {
        const w = args.window as { start_ms?: number; end_ms?: number }
        const latest = xsAll[xsAll.length - 1]
        const lo = latest + Number(w.start_ms ?? -1000)
        const hi = latest + Number(w.end_ms ?? 0)
        startIdx = xsAll.findIndex((t) => t >= lo)
        if (startIdx < 0) startIdx = 0
        const e = xsAll.findIndex((t) => t > hi)
        endIdx = e < 0 ? xsAll.length : e
      }
      const slice = (arr: number[], from: number, to: number): number[] => arr.slice(from, to)
      return {
        channels,
        xs: slice(xsAll, startIdx, endIdx),
        series: history.slice(1).map((ch) => slice(ch, startIdx, endIdx))
      }
    },

    async get_dashboard(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      return { fields: s.dashboard.latestFields, lastFrame: s.dashboard.lastFrame }
    },

    async list_quick_commands() {
      return {
        commands: ctx.commands.list().map((c) => ({
          id: c.id,
          name: c.name,
          payload: c.payload,
          mode: c.mode,
          appendNewline: c.appendNewline,
          loopIntervalMs: c.loopIntervalMs,
          loopCount: c.loopCount
        }))
      }
    },

    // ── 连接管理（写）────────────────────────────────────
    async connect_serial(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const port = String(args.port ?? '')
      if (!port) throw new ToolError('port 不能为空')
      if (s.serial.connected) throw new ToolError(`会话 ${s.id} 已连接（${s.serial.selectedPort}），请先 disconnect`)

      // 端口合法性：会话已枚举到端口时校验在列（无端口数据=未枚举，不拦截）
      const known = s.serial.ports
      if (known.length > 0 && !known.some((p) => p.path === port)) {
        throw new ToolError(`端口不存在: ${port}（先调用 list_serial_ports / list_sessions 查看可用端口）`)
      }
      if (ctx.confirmConnect && !(await ctx.confirmConnect(port, 'connect'))) {
        throw new ToolError('连接被用户取消（settings.mcp.confirmConnect 开启时 AI 连接需确认）')
      }

      const opts = (args.options ?? {}) as Partial<typeof s.serial.options>
      if (Object.keys(opts).length > 0) Object.assign(s.serial.options, opts)
      s.serial.selectedPort = port
      await s.serial.connect() // 抛错由调用方捕获
      return { ok: true, port, baudRate: s.serial.options.baudRate, transport: s.serial.driverType }
    },

    async disconnect(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      if (!s.serial.connected) throw new ToolError(`会话 ${s.id} 未连接，无可断开`)
      const port = s.serial.selectedPort ?? ''
      if (ctx.confirmConnect && !(await ctx.confirmConnect(port, 'disconnect'))) {
        throw new ToolError('断开被用户取消（settings.mcp.confirmConnect 开启时 AI 操作需确认）')
      }
      await s.serial.disconnect()
      return { ok: true, port }
    },

    // ── 发送（写）────────────────────────────────────────
    async send_bytes(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const data = Array.isArray(args.data) ? (args.data as number[]) : []
      const bytes = Uint8Array.from(data.map((n) => n & 0xff))
      const r = await s.serial.sendRaw(bytes)
      if (!r.ok) throw new ToolError(r.error ?? '发送失败')
      return { sent_bytes: bytes.length }
    },

    async send_string(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const text = String(args.text ?? '')
      const lineEnding = (args.lineEnding ?? 'none') as 'none' | 'cr' | 'lf' | 'crlf'
      const r = await s.serial.send(text, 'ascii', lineEnding, s.settings.encoding, s.checksum.send)
      if (!r.ok) throw new ToolError(r.error ?? '发送失败')
      return { ok: true, sent: text.length }
    },

    async run_quick_command(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const key = String(args.commandIdOrName ?? '')
      const cmd =
        ctx.commands.list().find((c) => c.id === key) ?? ctx.commands.list().find((c) => c.name === key)
      if (!cmd) throw new ToolError(`快速命令不存在: ${key}（先调用 list_quick_commands）`)

      // 与 QuickCommandsPanel.runOnce 同链：占位符展开 + 行尾/校验和 inherit 解析
      const payload = expandCommandVars(cmd.payload, cmd.mode, { seq: ctx.commands.nextSeq(cmd.id) })
      const ending = cmd.appendNewline === 'inherit' ? 'crlf' : cmd.appendNewline
      const cs = !cmd.checksum || cmd.checksum === 'inherit' ? s.checksum.send : cmd.checksum
      const r = await s.serial.send(payload, cmd.mode, ending, 'utf-8', cs)
      if (!r.ok) throw new ToolError(r.error ?? '发送失败')
      return { ok: true, command: cmd.name, sent: payload.length }
    },

    // ── 会话控制（写）────────────────────────────────────
    async set_paused(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      s.messages.paused = Boolean(args.paused)
      return { paused: s.messages.paused }
    },

    async clear_messages(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      s.messages.clear()
      return { ok: true }
    }
  }

  return {
    async handle(tool, args) {
      const def = MCP_TOOLS.find((t) => t.name === tool)
      if (!def || !(tool in handlers)) throw new ToolError(`未知工具: ${tool}`)
      const result = await handlers[tool](args ?? {})
      // 统一 JSON round-trip：剥离 Vue 响应式 proxy / Uint8Array 等 Electron IPC
      // 结构化克隆无法处理的值（DataCloneError: An object could not be cloned）
      return JSON.parse(JSON.stringify(result)) as unknown
    }
  }
}