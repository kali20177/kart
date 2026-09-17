import { z, type ZodTypeAny } from 'zod'

/**
 * MCP 工具契约——主进程 list_tools 与渲染进程 tool handler 共用的唯一权威定义。
 *
 * 静态共享（主/渲染各自 import，见 docs/mcp-design.md §D5）：只含 schema 定义与
 * TS 类型。inputSchema 用 zod raw shape（SDK 的 registerTool 只接受 zod 类型，
 * 内部自动转 JSON Schema 暴露给客户端）；渲染端只读 name/description/write，
 * 不执行校验（校验在主进程 SDK 完成）。
 * 数值上限写死在 description 中（MCP 客户端据此引导模型），实现时 clamp。
 */

/** 单个工具定义。write=true 表示写操作：read-only 模式拒绝调用。 */
export interface McpToolDef {
  name: string
  description: string
  write: boolean
  inputSchema: Record<string, ZodTypeAny>
}

export const MCP_TOOLS: McpToolDef[] = [
  // ── 读工具 ──────────────────────────────────────────────
  {
    name: 'list_serial_ports',
    description:
      '列出系统可用串口 [{path, manufacturer?, vendorId?, productId?, busy?}]。' +
      'busy=true 表示被其他程序占用。连接前先用它确定端口名，' +
      '可按 manufacturer/vendorId/productId 识别目标设备。',
    write: false,
    inputSchema: {}
  },
  {
    name: 'list_sessions',
    description:
      '列出全部已打开会话 [{id, port, transport, connected, baudRate, paused, stats:{rxFrames,txFrames,rxErrorFrames,droppedFrames}, bufferUsage}]。' +
      'sessionId 参数类工具都用这里的 id。会话面板由用户在 Kart 界面创建。',
    write: false,
    inputSchema: {}
  },
  {
    name: 'get_session_status',
    description:
      '读取单个会话的详细状态：连接参数（port/baud/encoding/frameStrategy）、缓冲利用率、收发统计、帧解码与校验和配置。',
    write: false,
    inputSchema: { sessionId: z.number() }
  },
  {
    name: 'get_recent_messages',
    description:
      '读取指定会话最近 count 条消息帧（新增在前）。mode 决定返回 hex 与 ascii 中的哪个字段（ascii 按会话编码 lossy 解码）。' +
      'filter 可按方向（rx/tx）与文本/hex 子串过滤；decode=true 时附带解码字段块。超 4096B 的帧折叠为 512B 预览。' +
      'count 上限 500（默认 50）。',
    write: false,
    inputSchema: {
      sessionId: z.number(),
      count: z.number().min(1).max(500).default(50),
      mode: z.enum(['ascii', 'hex']).default('hex'),
      filter: z
        .object({
          direction: z.enum(['rx', 'tx']).optional(),
          text: z.string().optional()
        })
        .optional(),
      decode: z.boolean().default(true)
    }
  },
  {
    name: 'search_messages',
    description:
      '在会话消息中搜索：query 为要查找的内容（mode=hex 时按 hex 子串匹配，否则按解码文本匹配）。' +
      '返回命中的帧列表（上限 100 条）。',
    write: false,
    inputSchema: {
      sessionId: z.number(),
      query: z.string(),
      mode: z.enum(['ascii', 'hex']).default('ascii'),
      direction: z.enum(['rx', 'tx']).optional(),
      limit: z.number().min(1).max(100).default(100)
    }
  },
  {
    name: 'get_waveform',
    description:
      '读取会话波形数据（仅文本行解析，如 "label:value" 或裸数值行）。' +
      'window.start_ms/end_ms 为相对最新时间戳的毫秒偏移（负数=过去，如 start=-1000/end=0 即最近 1 秒）；' +
      'recent 为取最近 N 个采样点（上限 5000）。返回 {channels:[名称], xs:[...], series:[[通道值...]...]}。',
    write: false,
    inputSchema: {
      sessionId: z.number(),
      window: z
        .object({
          start_ms: z.number().default(-1000),
          end_ms: z.number().default(0)
        })
        .optional(),
      recent: z.number().min(1).max(5000).optional()
    }
  },
  {
    name: 'get_dashboard',
    description:
      '读取会话仪表盘：解码字段最新值表 {fieldKey: {number, display, timestamp}} 与最近一帧解码快照。' +
      '依赖帧解码器（decoder-config）命中，无解码数据时返回空对象。',
    write: false,
    inputSchema: { sessionId: z.number() }
  },
  {
    name: 'list_quick_commands',
    description:
      '列出快速命令 [{id, name, payload, mode, appendNewline, loopIntervalMs, loopCount}]，配合 run_quick_command 使用。',
    write: false,
    inputSchema: {}
  },

  // ── 连接管理（写）──────────────────────────────────────
  {
    name: 'connect_serial',
    description:
      '在指定会话上打开串口（等价用户在 ConnectionBar 连接）。options 缺省沿用会话当前参数。' +
      '连接即共享状态：连接后与界面同步显示，按端口持久化的解码器/校验和/仪表盘配置自动生效。' +
      '失败情形返回明确错误：端口不存在/被占用/会话已连接。v1 仅串口传输，TCP/RTT 不支持。',
    write: true,
    inputSchema: {
      sessionId: z.number(),
      port: z.string(),
      options: z
        .object({
          baudRate: z.number().int().min(1).max(10000000).optional(),
          dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
          stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
          parity: z.enum(['none', 'even', 'odd']).optional(),
          flowControl: z.enum(['none', 'hardware']).optional()
        })
        .optional()
    }
  },
  {
    name: 'disconnect',
    description: '断开指定会话的当前连接（等价点击 ConnectionBar 断开）。未连接时报错。',
    write: true,
    inputSchema: { sessionId: z.number() }
  },

  // ── 发送（写）──────────────────────────────────────────
  {
    name: 'send_bytes',
    description:
      '向指定会话发送原始字节（data 为 0-255 字节数组，原样发送，不追加行尾）。' +
      '返回发送字节数；未连接报错。',
    write: true,
    inputSchema: {
      sessionId: z.number(),
      data: z.array(z.number().int().min(0).max(255))
    }
  },
  {
    name: 'send_string',
    description:
      '向指定会话发送文本（按会话当前编码编码，会话默认发送校验和生效）。' +
      'lineEnding 缺省 none（不加换行）；shell 类设备通常需要 "cr" 或 "crlf"。返回发送字节数。',
    write: true,
    inputSchema: {
      sessionId: z.number(),
      text: z.string(),
      lineEnding: z.enum(['none', 'cr', 'lf', 'crlf']).default('none')
    }
  },
  {
    name: 'run_quick_command',
    description:
      '在指定会话上执行一条快速命令（同 QuickCommandsPanel 点击）：占位符（{time}/{time:full}/{seq}/{rand}）' +
      '自动展开、按命令配置的会话校验和联动。commandIdOrName 可用命令 id 或名称匹配。返回命令名与实际发送字节数。',
    write: true,
    inputSchema: {
      sessionId: z.number(),
      commandIdOrName: z.string()
    }
  },

  // ── 会话控制（写）──────────────────────────────────────
  {
    name: 'set_paused',
    description: '暂停/恢复指定会话的消息接收（暂停时数据不缓冲，恢复后继续实时接收）。',
    write: true,
    inputSchema: {
      sessionId: z.number(),
      paused: z.boolean()
    }
  },
  {
    name: 'clear_messages',
    description: '清空指定会话的消息列表与统计（与界面「清空」按钮行为一致）。',
    write: true,
    inputSchema: { sessionId: z.number() }
  }
]

/** 工具名 → 定义 的索引（实现层用；name 唯一性由单测保证）。 */
export const MCP_TOOL_BY_NAME: ReadonlyMap<string, McpToolDef> = new Map(
  MCP_TOOLS.map((t) => [t.name, t])
)