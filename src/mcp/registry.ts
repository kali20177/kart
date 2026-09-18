import type { Message, QuickCommand, LineEnding, DataMode, Encoding, ChecksumAlgorithm } from '@/types'
import type { DecodeInfo } from '@/decoders/types'
import { bytesToHex, parseHexInput, findByteRanges } from '@/utils/hex'
import { decodeBytes, encodeText, concatBytes, lineEndingBytes } from '@/utils/encoding'
import { computeChecksum } from '@/utils/checksum'
import { findTextRanges } from '@/utils/search'
import { expandCommandVars } from '@/utils/command-vars'
import type { McpSessionRegistry } from '@/mcp/session-registry'
import { MCP_TOOL_BY_NAME } from '@/mcp/contract'

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

/** 缓冲利用率（0-1，两处状态工具共用；limit=0 视为无上限）。 */
function bufferUsage(msgs: readonly Message[], limit: number): number {
  return limit > 0 ? Math.round((msgs.length / limit) * 100) / 100 : 0
}

/** 与 serial.send 同构图计算一次发送的实际字节数（文本/hex 解析 + 校验和 + 行尾）。 */
function sentBytes(payload: string, mode: DataMode, encoding: Encoding, ending: LineEnding, checksum: ChecksumAlgorithm): number {
  let body: Uint8Array
  if (mode === 'hex') {
    const r = parseHexInput(payload)
    if (!r.ok) return 0
    body = r.bytes
  } else {
    body = encodeText(payload, encoding)
  }
  if (checksum !== 'none') body = concatBytes(body, computeChecksum(body, checksum))
  return concatBytes(body, lineEndingBytes(ending)).length
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
          decoderId: s.decoder.id || '',
          stats: {
            rxFrames: s.messages.rxFrames,
            txFrames: s.messages.txFrames,
            rxErrorFrames: s.messages.rxErrorFrames,
            droppedFrames: s.messages.droppedFrames
          },
          bufferUsage: bufferUsage(msgs, limit)
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
        bufferUsage: bufferUsage(msgs, limit),
        paused: s.messages.paused,
        decoderId: s.decoder.id || '',
        checksumSend: s.checksum.send,
        recording: s.recorder.isRecording,
        transferActive: s.transfer.hasActive,
        transferSending: s.transfer.isSending,
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
      const query = String(args.query ?? '').trim()
      const mode = args.mode === 'hex' ? 'hex' : 'ascii'
      const since = args.since == null ? undefined : Number(args.since)
      const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 100)
      if (!query) return { hits: [] }

      // hex 模式把 query 解析成字节序列（与界面搜索同一解析）；解析失败无命中
      const needle = mode === 'hex' ? (parseHexInput(query).ok ? parseHexInput(query).bytes! : null) : null
      if (mode === 'hex' && !needle) return { hits: [] }

      // 复用界面同一搜索纯函数（findTextRanges/findByteRanges，src/utils/search|hex）；
      // 从新到旧遍历，since 过滤最早时间戳，limit 截断（上限 100 写死 description，这里 clamp）
      const hits: Message[] = []
      for (let i = s.messages.messages.length - 1; i >= 0 && hits.length < limit; i--) {
        const m = s.messages.messages[i]
        if (since != null && m.timestamp < since) continue
        const matched =
          mode === 'hex'
            ? findByteRanges(m.bytes, needle!).length > 0
            : findTextRanges(decodeBytes(m.bytes, s.settings.encoding), query).length > 0
        if (matched) hits.push(m)
      }
      return { hits: hits.map((m) => formatMessage(m, s.settings.encoding, mode, true)) }
    },

    async get_waveform(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const history = s.waveform.history
      const xsAll = history[0]
      if (!xsAll || xsAll.length === 0) return { channels: [], xs: [], series: [] }

      const labels = s.waveform.textLabels
      // 通道数 = history 行数 - 1（store 形状 [X, ch1, ch2, …]）；label 缺失按序号补齐
      const channelCount = Math.max(0, history.length - 1)
      const channels = Array.from({ length: channelCount }, (_, i) => labels[i] ?? `CH${i + 1}`)

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
      // 点数封顶 5000（description 写死，实现时 clamp）——窗口跨度超限时保留最新段
      if (endIdx - startIdx > 5000) startIdx = endIdx - 5000
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
      // 其他会话占用（与 ConnectionBar 占用端口集合同一数据源，返回占用方 id）
      const occupiedBy = ctx.sessions
        .list()
        .find((o) => o.id !== s.id && o.serial.connected && o.serial.selectedPort === port)
      if (occupiedBy) {
        throw new ToolError(`端口 ${port} 已被其他会话占用（会话 ${occupiedBy.id} 已连接），请先断开该会话或换用它`)
      }
      if (ctx.confirmConnect && !(await ctx.confirmConnect(port, 'connect'))) {
        throw new ToolError('连接被用户取消（settings.mcp.confirmConnect 开启时 AI 连接需确认）')
      }

      const opts = (args.options ?? {}) as Partial<typeof s.serial.options>
      // 波特率 clamp 到 [1, 10_000_000]（description 写死上限，实现时 clamp）
      if (opts.baudRate != null) opts.baudRate = Math.min(Math.max(Number(opts.baudRate), 1), 10_000_000)
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
      const cs = s.checksum.send
      const r = await s.serial.send(text, 'ascii', lineEnding, s.settings.encoding, cs)
      if (!r.ok) throw new ToolError(r.error ?? '发送失败')
      // 实际发送字节数：同 serial.send 构图（编码 + 校验和 + 行尾）
      return { ok: true, sent_bytes: sentBytes(text, 'ascii', s.settings.encoding, lineEnding, cs) }
    },

    async run_quick_command(args) {
      const s = requireSession(ctx, Number(args.sessionId))
      const key = String(args.commandIdOrName ?? '')
      const commands = ctx.commands.list()
      const cmd = commands.find((c) => c.id === key) ?? commands.find((c) => c.name === key)
      if (!cmd) throw new ToolError(`快速命令不存在: ${key}（先调用 list_quick_commands）`)

      const sendOnce = async (): Promise<number> => {
        // 与 QuickCommandsPanel.runOnce 同链：占位符展开 + 行尾/校验和 inherit 解析
        const payload = expandCommandVars(cmd.payload, cmd.mode, { seq: ctx.commands.nextSeq(cmd.id) })
        const ending: LineEnding = cmd.appendNewline === 'inherit' ? 'crlf' : cmd.appendNewline
        const cs = !cmd.checksum || cmd.checksum === 'inherit' ? s.checksum.send : cmd.checksum
        const r = await s.serial.send(payload, cmd.mode, ending, 'utf-8', cs)
        if (!r.ok) throw new ToolError(r.error ?? '发送失败')
        return sentBytes(payload, cmd.mode, 'utf-8', ending, cs)
      }

      // 每命令循环（docs/mcp-design.md §6.2）：loopCount>1 按 loopIntervalMs 间隔整循环执行；
      // loopCount=0（无限循环）在阻塞性工具调用中按单次执行（description 已注明）
      const total = cmd.loopCount ?? 0
      const interval = Math.max(10, cmd.loopIntervalMs ?? 1000)
      const loops = total > 1 ? total : 1
      let sent = 0
      for (let i = 0; i < loops; i++) {
        if (!s.serial.connected) throw new ToolError(`会话 ${s.id} 已断开，循环在第 ${i + 1} 次停止`)
        sent += await sendOnce()
        if (i < loops - 1) await new Promise((resolve) => setTimeout(resolve, interval))
      }
      return { ok: true, command: cmd.name, sent, loops }
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
      const def = MCP_TOOL_BY_NAME.get(tool)
      if (!def || !handlers[tool]) throw new ToolError(`未知工具: ${tool}`)
      const result = await handlers[tool](args ?? {})
      // 统一 JSON round-trip：剥离 Vue 响应式 proxy / Uint8Array 等 Electron IPC
      // 结构化克隆无法处理的值（DataCloneError: An object could not be cloned）
      return JSON.parse(JSON.stringify(result)) as unknown
    }
  }
}
