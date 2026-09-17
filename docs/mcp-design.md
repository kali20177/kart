# Kart MCP 服务器设计 —— 让外部 AI 利用 Kart 能力并共享会话数据

> 2026-09-16。基于当前 master（`da8fe70`）。参照 Lissio（Codeberg `Horldsence/Lissio`，本地快照 `/Users/kali/Documents/Lissio`）的入站 MCP 设计与其差异点，结合 Kart 现有 Electron 双层架构（主进程 I/O 后端 + 渲染进程会话数据面）给出落地设计。全报告见 `docs/lissio-research.md` P0-5 章节。

## 一、背景与目标

Kart 是面向嵌入式调试的桌面串口工具，用户调试时的**会话数据**（收发的帧、解码字段、仪表盘、波形、统计）都在应用内。把这些能力对 AI 开放，可以让大模型在调试回路中扮演实际角色：看数据、发指令、跑快速命令、判断协议是否符合预期。

目标（MCP = Model Context Protocol，AI 客户端与工具提供方之间的标准协议）：

- **利用 Kart 能力**：枚举串口、向已打开的会话发送字节/文本、执行快速命令、暂停/清空消息流。
- **共享会话数据**：读取会话收到的帧（ASCII/HEX）、解码字段与仪表盘、波形数据、统计信息——与 UI 看到的是**同一份状态**（同一 reactive 数据面，非旁路复制）。
- **接入形态**：外部 AI 客户端（Claude Desktop / QwenCode / Cursor 等支持 MCP 的客户端）通过标准 MCP 客户端配置连接正在运行的 Kart 实例，零代码改动接入。

核心约束（串口工具特有，全程必须守住）：

- **会话容器归人，连接权可授权**：会话面板（dockview tab）是 UI 容器，由用户创建/销毁；对**已有会话**的 connect/disconnect 可由 AI 执行（受 token + 读写分级约束，默认不逐次确认）。连接状态与 GUI 实时共享——AI 连上/断开，ConnectionBar 同步显示，全程可见可审计。AI 的完整调试闭环（枚举→连→发→读→分析→断）不需要用户每次手动开串口。
- **绝不绕过 UI 状态**：AI 读写的就是会话 store，与界面实时同步，不存在第二份状态。
- **本地只读之外的动作必须授权**：本机 127.0.0.1 + Bearer token + 读写分级（Lissio 的无鉴权模式**不照抄**，见下）；连接管理随 read-write 授权直连，可选开启「连接前确认」。

## 二、参照设计

### 2.1 Lissio 入站 MCP（主参照，行为已验证）

Lissio（Rust + Tauri）在 `src-tauri/crates/desktop/mcp-server/` 实现入站 MCP server，要点：

| 维度 | Lissio 做法 | 对 Kart 的借鉴 |
| --- | --- | --- |
| 传输 | `rmcp` streamable-http，仅绑 `127.0.0.1:{port}`，端点为 `/mcp` | 同为 HTTP 入站；Kart 用官方 TS SDK 等价物 |
| 鉴权 | **无**。绑 loopback 即信任 | 不照抄——Kart 加 Bearer token + 读写分级 |
| 工具 | 19 个，覆盖发送字节/文本、CAN 帧、波形读取、节点图编辑、逻辑分析 | 只取与 Kart 能力对应的子集（无节点图/CAN） |
| 状态访问 | `Toolbox = AppState` 的 Arc 切片（transport / data_plane / 缓冲 / 工作区），工具拿共享句柄直读 | 等价物 = 渲染进程的会话 stores（同一 reactive 数据面） |
| 工具实现复用 | 同一 `tools.rs` 函数被三处调用：MCP handler + 内置 AI 原生执行器 + 前端托管事件桥（`ai_tool_invoke`/`ai_tool_resolve`，15s 超时） | Kart v1 只做 MCP 一路，但 provider registry 留好接口，未来内置 AI 助手可复用同一实现 |
| 生命周期 | `mcp_server_start(port)` / `stop` / `status` 三命令，幂等；前端按钮控制 | Kart 主进程 `McpServer` 类暴露 `start/stop/getStatus`，UI 开关控制 |
| 读取上限 | `MAX_WAVEFORM_POINTS=10_000`、`MAX_RAW_BYTES=64KB`、读取 clamp 上限 | Kart 按自身数据量级定上限（见 §6） |
| 设备连接 | **MCP 不连接设备**（工作台形态：`list_devices` 只列已打开会话，发送以 `node_id` 定位） | **差异点**：Kart 增加 `connect_serial`/`disconnect` 工具——调试助手场景需要 AI 完整闭环（枚举→连→发→读→分析→断），连接管理的风险由鉴权分级 + 状态可见性兜住，不逐次打断用户（§6.5） |

### 2.2 MCP 协议本身（规范层面，2026-09 现状）

- 官方 TypeScript SDK `@modelcontextprotocol/sdk`（npm，纯 JS，Node 环境可跑）。Lissio 用 Rust `rmcp`，Kart 无 Rust，选官方 TS SDK。
- 传输规范：**streamable-http** 是当前主线 inbound 传输（HTTP + SSE 响应用于流式/通知），旧的 legacy SSE 传输已废弃；stdio 适合 CLI 工具被客户端 spawn，**不适合在线 GUI 应用**（Kart 无法被 spawn 成独立进程且拿不到运行中状态）。
- 鉴权：MCP 规范本身不定义鉴权，后续 OAuth 草案仍以 token 为核心。Kart v1 用固定 Bearer token（自定义头 `Authorization: Bearer <token>`），客户端配置里直接写死，简单可靠。

### 2.3 其他开源对照（简要）

- MCP 官方“参考服务器”（`modelcontextprotocol/servers`）给出了 filesystem/git 等 stdio 型示例：读工具带路径参数、写工具带显式确认模式——Kart 参考其**工具描述与参数范式**，但 stdio 传输不适用。
- 串口/示波器类桌面工具中，`Serial Studio`、`uscope`、`demcon` 均无内建 MCP；Lissio 是当前唯一具备入站 MCP 的同赛道工具，故此设计以 Lissio 为唯一结构参照，辅以 MCP 官方规范。

## 三、现状盘点：缺口分析

| 环节 | 现状 | 缺口 |
| --- | --- | --- |
| 数据面 | 会话 stores（messages/waveform/dashboard/…）在渲染进程，store 八件套经 `useSession()` 取 | 无外部读取通道 |
| 发送能力 | `serial.sendRaw` / commands store（快速命令全逻辑含占位符展开） | 无外部调用通道 |
| 主进程 | SerialPortManager/TcpManager/PtyManager 均为窗口绑定，数据推 `webContents` | 无 HTTP 端点、无鉴权、无工具层 |
| 依赖 | dependencies 无 MCP SDK | 需加 `@modelcontextprotocol/sdk`（随应用打包） |
| 设置 | settings store 无 MCP 配置 | 需扩展 `AppSettings` + 迁移 |
| UI | SettingsModal 多 tab（输入/校验/终端/主题/…） | 需「AI」tab 控制 MCP server |
| 测试 | Vitest + Playwright CDP verify:* 脚本 | 需 MCP 单测 + e2e 脚本 |

## 四、总体架构

```
┌─ AI 客户端（Claude Desktop / QwenCode / …）─────────────┐
│  配置: "type": "streamable-http", url, Bearer token     │
└───────────────┬─────────────────────────────────────────┘
                │ HTTP (streamable-http, 127.0.0.1:<port>/mcp)
┌───────────────┴─────────────────────────────────────────┐
│ 主进程 src/main/McpServer.ts（单例，随 app 生命周期）      │
│  - @modelcontextprotocol/sdk StreamableHTTPServerTransport│
│  - 鉴权中间件：Authorization: Bearer 校验 + 读写分级 gate  │
│  - 工具两段式：list_tools 回复共享契约；call_tool 经桥转发 │
│  - 桥：webContents.send('mcp:tool-call',{callId,tool,args})│
│       ← ipcRenderer.invoke('mcp:tool-result',{callId,...})│
│  - 15s 超时（Lissio 同款 ai_tool_resolve）                │
│  - 状态推送 updater 同族：mcp:event → 渲染端状态条        │
└───────────────┬─────────────────────────────────────────┘
        preload（mcp.* 桥：start/stop/getStatus/onEvent/
                 tool-result 应答通道）
┌───────────────┴─────────────────────────────────────────┐
│ 渲染进程 src/mcp/（注册表模式，同 decoders/themes 同款）  │
│  - contract.ts：工具定义（name/description/schema/write） │
│    —— 静态共享文件，主进程与渲染进程各自 import           │
│  - sessions.ts：全局会话注册表（App.vue 建会话时注册/     │
│    dispose 注销；MCP 的 list_sessions 与 sessionId 路由）  │
│  - registry.ts：name → handler；handler 经会话注册表       │
│    解析 sessionId，直读/写会话 stores（同一 reactive 面） │
│  - 未来内置 AI 助手可复用同一 registry（三路复用接口预留） │
└──────────────────────────────────────────────────────────┘
```

要点：**主进程只管传输/鉴权/桥转发，工具实现全部在渲染进程**，因为会话数据面在渲染进程（messages/waveform/dashboard 的 stores），工具逻辑零复制、与 UI 天然同步——这是 Lissio `Toolbox = AppState 切片` 在 Kart 上的等价形态。主进程没有第二份状态，也就不存在“两边状态漂移”问题。

## 五、关键决策

### D1 服务端放主进程，工具实现放渲染进程（桥转发）

- 备选 A（否决）：渲染进程直接起 HTTP server——渲染进程是浏览器沙箱（`contextIsolation:true`、`nodeIntegration:false`），无法监听 socket；放开安全模型不可接受。
- 备选 B（否决）：主进程复制一份数据面——状态双份、与 UI 漂移，违背“绝不绕过 UI 状态”约束。
- **定案**：主进程 `McpServer.ts` 起 server；`call_tool` 经 ping-pong 桥转发渲染进程 registry 执行。桥的应答通道是 `ipcRenderer.invoke`（渲染→主），请求通道是 `webContents.send`（主→渲染），配 `callId` 关联，15s 超时（Lissio `ai_tool_invoke/ai_tool_resolve` 同款时限）；渲染进程崩溃时工具超时报错，server 本体存活（可查状态、可停止）。

### D2 传输：streamable-http，仅绑 127.0.0.1

- stdio 不适用（见 §2.2）；绑 loopback 保证不暴露到局域网（v2 若需局域网共享，另行设计白名单/防火墙，v1 不做）。
- SDK 版本：实施时锁最新 1.x；主进程为 CJS 输出，接入时验证 `@modelcontextprotocol/sdk` 的 CJS require 路径（同 electron-updater 的集成方式）；若 vite 打包有问题，将该依赖 externalize 后随 `node_modules` 打包。

### D3 鉴权与授权：Bearer token + 读写分级（差异化 Lissio）

- **token**：请求头 `Authorization: Bearer <token>`，缺失/错误 → 401。
  - 默认：每次启动随机生成（`crypto.randomBytes(24).toString('base64url')`），**不持久化**——重启即作废，最安全。
  - 可选：用户在设置里填固定 token（持久化进 `settings.mcp.token`）——方便客户端配置长期可用；提供「重新生成」按钮清除自定义值回到随机模式。
- **分级**：`settings.mcp.mode ∈ { off, read-only, read-write }`，默认 `off`（不启动 server）。工具定义打 `write` 标记，read-only 下调用写工具返回权限错误。
- **CSRF**：token 走 Authorization 头、不依赖 cookie，天然免疫 CSRF；curl/脚本误用时 UI 状态条实时可见（可审计）。
- 不抄 Lissio 的“绑定 loopback 即无鉴权”，理由：本机其他进程（被攻破的浏览器扩展/后台程序）也可访问 loopback，串口写操作须有明确凭据。

### D4 工具集 v1：13 个（读 7 / 写 6 含连接管理 2；get_session_status 含统计）

定义见 §6。范围裁剪：不做会话创建（会话面板是 UI 容器，见 §6.5）、不做解码器配置热改、不做 CAN/节点图（Kart 无此能力）。v2 预留：`create_session`、tcp/rtt 驱动连接、录制/下发启停、信号线（DTR/RTS/Break）、帧标注、流式推送（notifications）。

### D5 工具契约静态共享

工具定义（name/description/inputSchema/write 标记）放 `src/mcp/contract.ts`，主进程与渲染进程各自 import——`list_tools` 不必等渲染进程启动即可应答，也避免两处重复定义漂移。该文件只含 JSON schema 常量与 TS 类型，无 DOM/Node 依赖，两个 tsconfig（`tsconfig.json` / `tsconfig.node.json`）都能编。

### D6 会话定位与生命周期

- 工具以 `sessionId: number` 定位会话（`list_sessions` 先返回 id 列表）；渲染进程用现有 `useSession()` 按 id 解析。
- 会话销毁后调用 → 工具返回“会话不存在”错误。
- server 生命周期跟随主进程（窗口全关 macOS 常驻时 server 继续服务，AI 任务不中断）；新窗口/渲染进程重建后桥自动恢复（callId 基于递增计数，无跨重启状态）。
- 单窗口多会话是当前唯一形态；多窗口 v2 需把桥定向到具体 webContents，设计里预留 `McpBridge.target(winId)` 参数。

## 六、工具集设计（v1）

工具签名用 JSON Schema 声明（MCP 客户端据此生成参数），数值上限直接写死在 description 里，实现时 clamp（Lissio 同款 `clamp` 语义）。

### 6.1 读工具（read-only 可用）

| 工具 | 输入 | 输出要点 | 上限 |
| --- | --- | --- | --- |
| `list_serial_ports` | — | `[{path, manufacturer?, vendorId?, productId?, busy?}]`（与 ConnectionBar 同数据源；busy=被其他程序占用） | — |
| `list_sessions` | — | `[{id, port, transport, connected, baudRate, paused, decoderId, stats:{rxFrames,txFrames,rxErrorFrames,droppedFrames}, bufferUsage}]` | — |
| `get_session_status` | `sessionId` | 单会话详报：连接参数、缓冲利用率、统计、帧解码配置摘要、录制/下发是否进行中 | — |
| `get_recent_messages` | `sessionId, count, mode('ascii'\|'hex'), filter?:{direction?, text?}, decode?:bool` | 帧数组 `[{id,direction,ts,hex,ascii?,len,note?,error?,checksumFailed?,decoded?}]`；`decoded` 与 UI 字段块同构 | count ≤ 500（默认 50）；单帧 >4096B 折叠为 512B 预览（复用 MessageBubble 截断语义） |
| `get_waveform` | `sessionId, window?:{start_ms,end_ms}, recent?:count` | 通道列表 + `{ts, values[]}` 点列（读 waveform store，含历史缓冲） | 点数 ≤ 5000（与 `maxPoints` 同数量级） |
| `get_dashboard` | `sessionId` | 解码字段最新值表 + 最近一帧快照（dashboard store 数据） | — |
| `search_messages` | `sessionId, query, mode, since?, limit` | 命中帧列表（复用现有搜索纯函数 `search/utils`） | limit ≤ 100 |

### 6.2 写工具（read-write 可用；连接管理作用于已有会话，语义见 §6.5）

| 工具 | 输入 | 行为 | 说明 |
| --- | --- | --- | --- |
| `connect_serial` | `sessionId, port, options?:{baudRate,dataBits,stopBits,parity,flowControl}` | 在指定会话打开串口：设 `serial.selectedPort = port`（按端口解码/校验/仪表盘配置的 watcher 自动加载）后 `await serial.connect()`——与 ConnectionBar 完全同路 | `port` 须存在于 `list_serial_ports`；options 缺省沿用会话当前参数；已连接/端口不存在/busy/被其他会话占用 → 明确错误 |
| `disconnect` | `sessionId` | 关闭该会话连接（`serial.disconnect()`，等价 ConnectionBar 断开） | 未连接 → 错误「未连接」 |
| `send_bytes` | `sessionId, data:number[]`(0-255) | `serial.sendRaw` 原样发送 | 返回发送字节数；未连接报错 |
| `send_string` | `sessionId, text, lineEnding?:'none'\|'cr'\|'lf'\|'crlf'` | 按会话当前编码编码后发送；`lineEnding` 缺省不加 | 与输入框发送同链路（含校验和配置生效） |
| `run_quick_command` | `sessionId, commandIdOrName` | 复用处命令全部逻辑：占位符 `{time}/{seq}` 等展开、每命令循环、会话校验和 | 返回命令标题 + 实际发送字节 |
| `set_paused` | `sessionId, paused:boolean` | pause store 切换 | — |
| `clear_messages` | `sessionId` | messages.clear() | 与按钮行为一致 |

### 6.3 契约示例（`src/mcp/contract.ts`）

```ts
/** 主进程 list_tools 与渲染进程 registry 共用的工具定义（静态共享，无运行时依赖） */
export interface McpToolDef {
  name: string
  description: string
  write: boolean          // read-only 模式下拒绝
  inputSchema: {          // JSON Schema（MCP inputSchema 子集）
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'send_string',
    description: '向指定会话发送 UTF-8 文本（按会话当前编码编码，不自动加换行）。sessionId 先经 list_sessions 获取。返回发送字节数',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: '会话 id（list_sessions 返回）' },
        text: { type: 'string' },
        lineEnding: { enum: ['none', 'cr', 'lf', 'crlf'], default: 'none' }
      },
      required: ['sessionId', 'text']
    }
  },
  // …get_recent_messages / send_bytes / run_quick_command …
]
```

### 6.4 帧数据格式约定

帧字节统一返回 **hex 字符串**（避免 Uint8Array 过桥序列化问题）+ 可选 `ascii`（按会话编码 lossy 解码，与 MessageBubble 同一格式化函数）。`mode` 参数只决定返回哪个字段（可同时要两者）。Lissio raw-data 同款“hex + 方向 + 时间戳”风格，Kart 在此基础上加 `decoded` 字段块。

### 6.5 AI 连接管理语义

- **会话容器归人，连接权可授权**：会话面板（dockview tab）由用户创建（`+` 按钮/布局操作），MCP 不建会话（v2 再评估 `create_session`）。AI 的完整调试闭环是：`list_serial_ports` 挑设备（按 vid/pid/manufacturer 确认）→ `list_sessions` 拿会话 id → `connect_serial` → 发/读/分析 → `disconnect`。用户只需保证面板存在，无需每次手动开串口。
- **连接即共享状态**：`connect_serial` 内部就是 `serial.selectedPort = port` + `serial.connect()`——与用户在 ConnectionBar 操作完全同路：按端口持久化的解码器/校验和/仪表盘配置自动生效，UI 同步显示连接态，根本没有"AI 专属连接"这回事。
- **失败语义**：端口不存在或 busy（被其他程序占用）→ 明确错误；会话已连接 → 错误提示先断开；其他会话占用同一端口 → 复用 `useOccupiedPorts` 集合返回占用方信息。
- **授权**：连接属 write 类工具，`read-only` 模式拒绝；默认不逐次确认（AI 直接执行，连接状态在 ConnectionBar 实时可见、可审计），设置提供「连接前确认」开关（默认关）供敏感场景。
- **范围**：v1 仅串口传输（`connect_serial`）；tcp/rtt 的 AI 驱动连接 v2 再开（底层驱动已具备，只是工具面未开）。

## 七、主进程 `src/main/McpServer.ts` 设计

```ts
class McpServer {
  // 状态机：stopped → starting → running(port) → stopping；幂等 start/stop
  async start(port: number, token: string): Promise<number>  // 返回实际绑定端口
  stop(): void
  getStatus(): { running: boolean, port: number | null }
  // 鉴权中间件：比对 Bearer token；模式 gate 查渲染端同步的 mode（或主进程缓存一份）
}
```

- 启动：`app.whenReady` 后不自动启动；渲染端开关打开时经 IPC 调 `mcp:start`（端口绑定失败 → 渲染端报错，不改端口静默重试）。
- 工具路由：`call_tool` 到达后查共享契约（`MCP_TOOLS`）：
  - 无此工具 → unknown tool 错误；
  - `write` 且当前 mode 为 read-only → permission 错误；
  - 否则入队桥转发（§八）。
- `list_tools` / `list_resources`（v1 不提供 resources）直接由契约表应答，不经桥。
- 日志：全部走 `mainLogger`（`mcp` 域），含每次工具调用摘要（工具名/sessionId/耗时/结果码）——审计面。
- gate：浏览器构建（无主进程）本就不存在此模块；`electron:dev` 可正常起（127.0.0.1 无打包限制，同 updater 的 dev 可用策略）。

## 八、桥协议（主进程 ↔ 渲染进程）

```
main: call_tool → McpBridge.invoke(tool, args)
  1. 分配 callId（递增），入 pending Map（resolver + 15s 计时器）
  2. webContents.send('mcp:tool-call', { callId, tool, args })
renderer: registry 执行 handler → ipcRenderer.invoke('mcp:tool-result', { callId, ok, result?|error? })
main: 找到 callId → 清计时器 → ok ? success 结果 : 工具错误；超时未回 → internal error（"renderer timeout"）
     过期 callId（超时后才到）→ 静默丢弃
```

- 并发：pending Map 支持多个 in-flight（AI 客户端常并发调工具）。
- 应答通道 `mcp:tool-result` 由主进程 `ipcMain.handle` 注册一次（同既有 register*Ipc 模式）。
- 请求/应答载荷全 JSON 安全（工具输出已保证，见 §6.4）。
- 桥目标：单窗口下固定主窗口；`McpBridge.target(winId)` 参数预留多窗口。

### 渲染进程 `src/mcp/registry.ts` + `sessions.ts`

- `registerMcpTool(def, handler)` / `handleMcpToolCall(tool, args)`：handler 签名 `(ctx: { sessions: McpSessionRegistry, activeId: number | null }) => Promise<unknown>`。
- **`sessions.ts` 全局会话注册表**（新增小基础设施）：`registerSession(session)` / `unregisterSession(id)` / `listSessions()`。App.vue 新建会话时注册、dispose 时注销——`list_sessions` 与 `sessionId` 路由都走它。注意 `useSession()` 是组件树注入（`provideSession` 子树内有效），模块级 registry 拿不到，注册表才是模块级语义的正确位置（会话 id 复用 `session/index.ts` 的自增 id）。
- handler 实现直读/写会话 stores（`session.serial.selectedPort/connect/disconnect/sendRaw`、`session.messages.messages`、`session.checksum` 等公开 API），**全部逻辑复用现有纯函数/utils**（hex 格式化、搜索、命令占位符展开），不写第二套。
- 注册在渲染进程启动时完成（`renderer.ts` 或模块级），会话注册表为空时连接/发送类工具返回「无会话」。
- 接口预留：`McpRegistry` 仅依赖"会话注册表 + 工具表"，未来内置 AI 助手（Lissio 的 `ai_tool_invoke` 前端托管事件桥）可对该 registry 做第二路调用，v1 不实现。

## 九、设置与 UI

- **settings 扩展**：`AppSettings.mcp = { enabled:false, port:19281, mode:'off'|'read-only'|'read-write', token?:string }`（token 通常不落盘，见 D3）。settings store 加一次浅合并兜底（同 `terminal` 的处理模式），默认全关。
- **入口**：SettingsModal 新增「AI」tab（全局功能，非会话级，模式与现有 tab 一致；文案进 i18n zh/en）。
- **面板内容**：
  - 开关（默认关）；端口输入（默认 19281；占用时报错提示）；模式下拉（只读/读写）。
  - 连接管理区：「允许 AI 管理连接」说明（read-write 模式下 AI 可直接连接/断开会话串口，连接状态实时显示在 ConnectionBar）+「连接前确认」开关（默认关；开启后每次 AI 连接弹确认框）。
  - 状态条：`运行中 http://127.0.0.1:<port>/mcp`（绿色）/ 停止（灰）。
  - token 区：只读字段 + 「复制」+「重新生成」（清自定义回随机）。
  - 「复制客户端配置」按钮：生成 `claude_desktop_config.json` 片段（`type: "streamable-http"` + `url` + `headers: { Authorization: "Bearer <token>" }`），Copy 到剪贴板——AI 接入零手写。
- **状态条底栏**：MCP 运行中显示小标识（方便用户随时知道"AI 开着"——可审计性）；无多余打扰。

## 十、测试计划

| 层 | 内容 |
| --- | --- |
| 纯函数单测 | 契约表完整性（name 唯一、schema 合法、write 标记一致）；token 校验中间件；桥 callId 生命周期（超时/过期丢弃/并发）——vitest node 环境 |
| store 级 | registry handler 对 mock 会话（注入 mock 驱动）的行为：send_string 走编码/校验和、run_quick_command 占位符展开、get_recent_messages 折叠截断、read-only gate |
| 集成（node） | vitest 里起真实 `@modelcontextprotocol/sdk` streamable-http server + fetch 调 `list_tools`/`call_tool`，验证鉴权 401、读/写 gate、桥转发（mock 渲染端应答） |
| e2e | `scripts/verify-mcp.mjs`（Playwright CDP 驱动 Electron，仿 verify:dockview）：`?mock` 连会话 → 设置里开 MCP → 脚本用 fetch 直连 `127.0.0.1` 调 `list_sessions`/`send_string`/`get_recent_messages` → 断言 AI 发的字节能被读到（双路径字节一致，同 file-transfer 验证思路）；无 console 错误 |

## 十一、里程碑拆分

1. **M1 契约与桥**：`src/mcp/contract.ts` + 主进程 `McpServer`（SDK 接入、鉴权、start/stop/status IPC）+ preload 桥 + 渲染进程 registry 骨架；单测全绿。
2. **M2 读工具**：list_serial_ports / list_sessions / get_session_status / get_recent_messages / search_messages / get_waveform / get_dashboard；store 级测试。
3. **M3 写工具 + UI**：send_bytes / send_string / run_quick_command / set_paused / clear_messages；SettingsModal「AI」tab + i18n + 状态条标识。
4. **M4 e2e 收口**：`verify-mcp.mjs` + 文档文案校对；635+ 测试全绿后提交。

依赖：`npm i @modelcontextprotocol/sdk`（dependencies，随包）。无阻塞性前置。

## 十二、待确认（产品决策）

1. **默认模式**：v1 默认 `off`（用户手动开）还是默认 `read-only`？——建议默认 `off`，AI 接入是主动行为，首次使用引导成本低。
2. **token 静态化**：是否允许用户设置固定 token（便利性）vs 每次启动随机（安全性）？——建议两者都提供，「重新生成」一键回随机。
3. **连接授权粒度**：AI 连接默认随 read-write 直连（不逐次打断）还是默认弹确认？——建议默认直连 + 可选「连接前确认」开关（默认关）；`connect_serial`/`disconnect` 是否还需要独立于 read-write 的专属开关（如「允许 AI 管理连接」）？
4. **端口默认值 19281** 是否合适（避开 502/19021 等常见端口）？

## 十三、与 saucer 迁移的兼容性

Saucer 迁移当前停滞、主线仍是 Electron（master）。本设计在 Electron 主进程实现 HTTP server + IPC 桥。若未来迁 saucer（无 Electron 主进程概念），对应替代：Tauri 侧用 Rust `rmcp`（Lissio 同款）起 server，渲染端 registry 逻辑（纯 TS、依赖 stores）**可无损迁移**——与 `docs/upgrade-design.md` §15 的 updater 契约迁移结论同类：**契约/工具定义/渲染端实现后端无关，仅传输承载层换实现**。MCP 工具契约（§6.3）本身更是与后端完全无关的接口面。