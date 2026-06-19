# 串口调试助手（serial-demo）—— 阶段 1：前端 UI 实现计划

## Context

`c:\Users\28626\Desktop\serial-demo` 目前是空仓库（仅 `.git`）。
项目最终目标是基于 Electron + Web Serial API 做一款跨平台串口调试助手，但用户决定**分两阶段推进**：

- **阶段 1（本计划）**：仅做前端界面 + 交互，用**模拟数据**驱动消息流，重点打磨气泡视觉、ASCII/HEX 切换、快速命令面板、ASCII 对照表等纯 UI 部分。
- **阶段 2（后续）**：套 Electron 壳，接 Web Serial API，把模拟数据源替换为真实串口；持久化从 `localStorage` 切到 `electron-store`；加打包配置。

这样可以纯浏览器（Vite dev server）里反复调样式与交互，不被 Electron 主进程权限钩子、preload IPC 拖慢节奏。

已确认的取舍（沿用上一轮）：
- **Vue 3 + TypeScript**
- 范围：MVP + 嵌入式调试常用增强（在 UI 层全部呈现，数据源是模拟的）
- **Telegram 风**气泡，扁平化
- UI 库：**Naive UI**

## 阶段 1 技术栈

| 维度 | 选型 | 备注 |
| --- | --- | --- |
| 构建 | **Vite 5 + Vue 3 + TS** | 不引入 Electron；后续阶段再切到 electron-vite |
| 渲染 | Vue 3 + `<script setup>` | Composition API |
| 状态 | Pinia | serial / messages / commands / settings 四 store |
| UI 库 | Naive UI | 扁平、暗色完善、TS 友好 |
| 虚拟滚动 | `vue-virtual-scroller` | 海量消息流 |
| 持久化（阶段 1） | `localStorage`（包一层 `useStorage` composable） | 阶段 2 替换为 electron-store，接口不变 |
| 包管理 | pnpm | |

## 国内镜像源配置（务必先做）

参考已能跑通的 `C:\Users\28626\Desktop\electron-demo`，其 `.npmrc` 与 README 已把国内安装踩坑沉淀好，**直接复用同一份 `.npmrc`**。

在 `serial-demo` 根目录放置 `.npmrc`：

```ini
# npm 包仓库（淘宝 npmmirror）—— 阶段 1 就生效，加速所有依赖安装
registry=https://registry.npmmirror.com/

# Electron 预编译二进制 —— 阶段 2 装 electron 时关键，否则从 GitHub Release
# 拉几十 MB 二进制，国内大概率超时。小写 key 会被注入为 npm_config_* 环境变量，
# 被 electron / electron-builder 的 postinstall 读取。
electron_mirror=https://npmmirror.com/mirrors/electron/

# electron-builder 打包依赖二进制（winCodeSign / nsis 等）—— 阶段 2 打包时关键
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/

progress=true
```

要点与排查（摘自 electron-demo README，避免重复踩坑）：

- **阶段 1（纯 Vite，无 Electron）**：只有 `registry` 真正起作用，依赖体积小、装得快。
- **阶段 2（引入 Electron）**：`electron_mirror` 与 `electron_builder_binaries_mirror` 才变关键。常见故障：
  - 卡在 `electron@x postinstall` → 二进制下载超时 → 确认 `electron_mirror` 生效，删 `node_modules` 重装。
  - `getaddrinfo ENOTFOUND github.com` → 走了 GitHub → 检查 `.npmrc`。
  - 打包卡在下载 winCodeSign → 确认 `electron_builder_binaries_mirror` 已配。
  - SHA mismatch → 镜像缓存损坏 → `npm cache clean --force`。
- 若用 **pnpm**：`.npmrc` 中的 `registry` 同样被识别；electron 的镜像 env 变量（小写 key）也会注入，行为一致。临时一次性使用见 electron-demo README 第 1 节命令示例。

> 说明：`electron-demo` 用的是原生 `tsc` 构建，本项目阶段 2 改用 `electron-vite`（与其 README「扩展方向：接入 Vue + 热更新就换 electron-vite」的建议一致）。镜像 `.npmrc` 对两种构建链通用，无需改动。

## 可复用参考：electron-demo（阶段 2 套壳时照搬）

`electron-demo` 是一份已跑通的最小 Electron + TS 模板，阶段 2 直接借鉴其经过验证的部分，不重新发明：

- **`.npmrc`**：原样复制（见上）。
- **IPC 契约模式**：`src/shared/types.ts` 定义 `ElectronAPI` 接口，主进程实现 / preload 暴露 / 渲染层消费三方共享同一份类型——本项目阶段 2 的 `store` / `file` / `serial-permission` IPC 照此组织。
- **安全模型**：`contextIsolation: true`、`nodeIntegration: false`、`contextBridge` 白名单暴露（不直接开放 `ipcRenderer`）、CSP `default-src 'self'`。
- **主→渲染推送 + 反订阅**模式：`onXxx(cb) => 返回 removeListener`，本项目串口数据若走主进程时可复用（但阶段 2 计划让 Web Serial 跑在渲染层，IPC 主要用于持久化与文件对话框）。

## 模拟数据策略（替代真实串口）

用一个 `MockSerialSource` 类实现与最终 `useSerial.ts` **同接口**，只是数据来源换成定时器：

- 提供"场景预设"下拉，方便切换调试状态：
  - **静默**：连接但无数据
  - **AT 应答**：每次 TX 后延时 50–200 ms 模拟一段 ASCII 回复（如 `OK\r\n`、`+CSQ: 24,99\r\nOK\r\n`）
  - **二进制连续帧**：固定周期吐出带帧头 `0xAA 0x55` 的 hex 帧，验证 HEX 视图与帧切分
  - **高吞吐压测**：每 1 ms 吐 64 字节、持续 5 秒，验证虚拟滚动与节流
  - **混合 ASCII**：周期性日志 + 偶发中文（GBK 模拟）
- "假端口列表"：写死 `COM3 / COM7 / /dev/ttyUSB0`，让端口选择 UI 也能跑通。
- 假"信号线"状态：状态栏轮询时返回随机但稳定的 DSR/DCD/CTS。

阶段 2 直接把 `serial` store 内部的 `MockSerialSource` 换成 Web Serial 实现即可，**UI 与 store 接口不动**。

## 目录结构（阶段 1）

```
serial-demo/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── components/
│   │   ├── ConnectionBar.vue       # 端口下拉（假数据）、波特率/校验/停止位、连接按钮、信号灯
│   │   ├── MessageList.vue         # 虚拟滚动容器
│   │   ├── MessageBubble.vue       # 单条气泡（RX 左 / TX 右、时间戳、模式徽标、复制/重发）
│   │   ├── InputComposer.vue       # 发送框、ASCII/HEX 切换、行尾符、循环发送
│   │   ├── QuickCommandsPanel.vue  # 右侧抽屉：命令列表 + 拖拽 + 增删改 + 导入导出
│   │   ├── AsciiTable.vue          # ASCII 对照表（128 行）
│   │   ├── SettingsDrawer.vue      # 编码、帧切分策略、主题、缓冲上限
│   │   └── StatusBar.vue           # 连接态 / RX·TX 字节数 / 控制线状态
│   ├── stores/
│   │   ├── serial.ts          # 包装 MockSerialSource：connect/disconnect、收发统计
│   │   ├── messages.ts        # 环形缓冲 + 帧切分 + rAF 节流
│   │   ├── commands.ts        # 快速命令 CRUD（持久化）
│   │   └── settings.ts        # 全局设置（持久化）
│   ├── mock/
│   │   ├── MockSerialSource.ts # 与未来 Web Serial 同接口的模拟源
│   │   └── scenarios.ts        # 各种场景脚本
│   ├── composables/
│   │   ├── useSerial.ts       # 阶段 1 包装 Mock；阶段 2 切换为 Web Serial
│   │   ├── useFrameSplitter.ts# gap-timeout / delimiter / fixed-length
│   │   ├── useSendHistory.ts  # ↑/↓ 翻历史
│   │   └── useStorage.ts      # 阶段 1 用 localStorage；阶段 2 切 electron-store
│   ├── utils/
│   │   ├── hex.ts             # 解析多格式 hex 输入；HEX 视图格式化
│   │   ├── encoding.ts        # TextDecoder 包装 + GBK polyfill
│   │   └── ascii-table.ts     # 静态 ASCII 表数据
│   ├── styles/
│   │   ├── tokens.css         # CSS 变量：颜色 / 间距 / 圆角 / 等宽字体
│   │   └── theme-dark.css
│   └── types.ts               # Message / PortOptions / QuickCommand
└── README.md
```

阶段 2 切 Electron 时，仅在外层增加 `src/main/`、`src/preload/` 与 `electron.vite.config.ts`，渲染层目录原样保留。

## 关键 UI 行为

### 1. 气泡（MessageBubble.vue）

- 左右分列：RX 左对齐淡蓝、TX 右对齐淡绿；4 px 圆角、单色边框、扁平无阴影。
- 顶部 meta 栏：时间戳 `HH:mm:ss.SSS`、字节数、模式徽标（ASCII/HEX）、错误标记。
- 等宽字体（JetBrains Mono / Cascadia Mono）；HEX 模式按每 16 字节分行 + 右侧 ASCII 透视列。
- 悬停按钮：复制（按当前模式）、复制为 hex、再次发送（仅 TX）。
- 视图切到 ASCII / HEX 时**不重建数据**，气泡按当前模式即时格式化原始 `Uint8Array`。

### 2. 消息列表（MessageList.vue）

- `vue-virtual-scroller` 的 `RecycleScroller`，气泡高度按"最长行字符数"估算并缓存。
- 自动滚到底部；用户上滚后停止跟随，底部出现"回到最新"按钮。
- 顶部工具条：清空、暂停接收、过滤（按方向 / 关键字）。

### 3. 消息缓冲与节流（messages store）

- 定长环形缓冲（默认 5000，可配），溢出丢弃最早。
- 高频模拟数据时用 `requestAnimationFrame` 合并写入，避免响应式爆掉。

### 4. 帧切分（useFrameSplitter.ts）

设置中可选三种策略，模拟数据也走这个切分器：
- **gap-timeout**（默认 20 ms）：连续到达字节合并为一帧。
- **delimiter**：`\n` / `\r\n` / 自定义十六进制字节。
- **fixed-length**：固定 N 字节一帧。

### 5. 发送框（InputComposer.vue）

- 上方一排 chip：`ASCII | HEX`、`行尾: 无 / \\r / \\n / \\r\\n / 自定义`、`重复: 关 / 周期 ms / 次数`。
- HEX 输入解析：同时接受 `0A FF`、`0a,ff`、`0xAA 0xBB`、`aabbcc`；剔除非 hex 字符并提示，奇数长度报错。
- 历史：↑/↓ 翻本会话发送过的内容。
- 循环发送：周期定时器 + 计数；进行中按钮变"停止"。

### 6. 快速命令（QuickCommandsPanel.vue）

```ts
interface QuickCommand {
  id: string;
  name: string;
  payload: string;
  mode: 'ascii' | 'hex';
  appendNewline: 'inherit' | 'none' | 'cr' | 'lf' | 'crlf';
  color?: string;
}
```

- 列表项：name + payload 预览；点击发送；⋯ 菜单：编辑、删除、复制、调到发送框。
- 拖拽排序、JSON 导入导出。
- 阶段 1 内置示例命令（AT、AT+CSQ、AT+CGMI、查询版本 hex 帧），便于演示。

### 7. ASCII 对照表（AsciiTable.vue）

- 抽屉式，快捷键 `Ctrl+/` 调起。
- 0–127；列：DEC / HEX / OCT / 字符 / 控制名 / 转义。
- 控制字符（0–31, 127）淡灰底 + 名称；可打印字符正常显示。
- 行点击：插入到发送框（按当前 ASCII/HEX 模式）。

### 8. 设置抽屉（SettingsDrawer.vue）

- **接收**：编码（utf-8 / ascii / gbk）、帧切分策略与参数、缓冲上限。
- **显示**：默认视图（ASCII/HEX）、时间戳精度、主题（亮/暗/跟随系统）、字体大小。
- **模拟数据**（阶段 1 专属）：场景下拉、注入按钮，方便手动触发某段数据。
- **导出**：日志另存为 `.txt` —— 阶段 1 用浏览器 `Blob + a.download`，阶段 2 切到 Electron `dialog`。

### 9. 状态栏（StatusBar.vue）

- 左：连接态指示灯 + 端口名 + 串口参数概要（`115200 8N1`）。
- 中：RX / TX 累计字节数（连接期间，断开重置）。
- 右：信号线状态点（阶段 1 来自 Mock）。

## 主要文件触点

全是新增。重点产出：

- 项目骨架：`package.json` / `vite.config.ts` / `tsconfig.json` / `index.html`
- 入口：[src/main.ts](src/main.ts)、[src/App.vue](src/App.vue)
- 八大组件：路径见上文
- 四个 Pinia store：路径见上文
- 模拟源：[src/mock/MockSerialSource.ts](src/mock/MockSerialSource.ts)、[src/mock/scenarios.ts](src/mock/scenarios.ts)
- composables / utils / 类型 / 样式：路径见上文

## 验证方案

阶段 1 的"端到端"就是**用模拟数据把整个 UI 走一遍**：

1. `pnpm dev` 启动，确认窗口出现，所有面板就位。
2. 点"连接" → 假端口列表 → 选一个 → 状态栏变绿。
3. 切换"AT 应答"场景，发送 `AT`，看 TX 气泡（右）+ RX 气泡（左）正确出现，时间戳精确到毫秒。
4. 切到 HEX 视图：所有气泡即时重排为 16 字节/行 + ASCII 透视列，原始数据不丢。
5. 切"二进制连续帧"场景，HEX 模式下气泡按帧分隔正确（验证 `useFrameSplitter`）。
6. 切"高吞吐压测"场景：UI 不卡顿（虚拟滚动 + rAF 节流生效）；缓冲到上限后老消息开始丢弃。
7. 在发送框输入 `AA 55,01,02 0x03 ff` → HEX 解析为 `AA 55 01 02 03 FF`；输入奇数长度报错。
8. 循环发送：5 次 / 200 ms，触发后能看到 5 条 TX 气泡，按"停止"中断。
9. 快速命令面板：新建、编辑、拖拽排序、导出 JSON、清掉再导入还原。
10. ASCII 对照表：`Ctrl+/` 弹出 → 点击 `0x0A` → 发送框出现 `\n`（ASCII 模式）或 `0A`（HEX 模式）。
11. 设置抽屉切主题、切编码（GBK 场景下中文回显正确）、改缓冲上限并验证。
12. 浏览器刷新后：快速命令、设置项均从 localStorage 还原。
13. 单元测试（Vitest）：覆盖 `utils/hex.ts`、`utils/encoding.ts`、`useFrameSplitter.ts` 这些纯逻辑模块。

阶段 1 验收通过即进入阶段 2：套 Electron 壳 + 接 Web Serial + 替换持久化与导出。

## 实施顺序（阶段 1 内部）

1. 先放 `.npmrc`（复制 electron-demo 的镜像配置），再 `pnpm create vite` 起 Vite + Vue + TS + Pinia + Naive UI 骨架，配 `tokens.css` 与等宽字体。
2. `types.ts` + `MockSerialSource` + `serial` store + `messages` store（含帧切分、rAF 节流）。
3. `MessageList` + `MessageBubble` + 数据通路打通；先把"AT 应答"场景跑起来。
4. `InputComposer`（含 hex 解析 / 行尾 / 历史 / 循环发送）。
5. ASCII/HEX 视图切换打磨：HEX 透视列对齐、长帧换行、复制为 hex。
6. `QuickCommandsPanel` + `useStorage` + 内置示例命令。
7. `AsciiTable` 抽屉 + `Ctrl+/` 快捷键 + 插入逻辑。
8. `SettingsDrawer` + `StatusBar` + 主题切换。
9. Vitest 单测 + README（含阶段 2 落地路径说明）。
