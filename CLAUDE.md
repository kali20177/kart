# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作提供指引。

## 常用命令

```sh
npm run dev            # 启动 Vite 开发服务器（localhost:5273，浏览器）
npm run build          # 类型检查 + 生产构建（vue-tsc --noEmit && vite build）
npm run preview        # 本地预览生产构建
npm run typecheck      # 仅执行 vue-tsc 类型检查（不输出文件）
npm test               # 运行所有 Vitest 测试（单次）
npm run test:watch     # 以 watch 模式运行测试
npm run electron:dev   # 在 Electron 中以开发模式运行（含 HMR + 主/预加载自动重启）
npm run electron:build # 类型检查 + 构建 + electron-builder 打包（输出 release/）
npm run electron:preview # 构建后用 electron 直接运行（不打包）
npm run verify:terminal # Playwright CDP 驱动 Electron 验证终端视图（mock shell 交互）
npm run verify:pty     # 验证本地终端（node-pty spawn 真实 shell → vim 全屏）
npm run verify:dockview # 验证多会话 dockview 布局（并排/关闭/新建会话）
```

## 视觉委派

主模型可能不具备视觉能力。凡是涉及图片/截图/图像内容的任务，一律通过 Agent 工具调用 `vision` 子代理（frontmatter `model: haiku`，解析到具备视觉能力的模型）分析后再继续，主模型不得直接 Read 图片文件。

## 项目概览

串口调试助手 —— 面向嵌入式开发调试的现代化串口工具。Vue 3 SPA，三种传输后端可切换，同一份代码同时支持浏览器（Web Serial API）和 Electron 桌面应用（serialport npm 库），打包输出 Windows/macOS/Linux 三平台安装包。

- **框架**：Vue 3（`<script setup>` Composition API）
- **构建**：Vite 5、TypeScript strict、`@/` 路径别名 → `src/`
- **桌面打包**：Electron 31 + vite-plugin-electron + electron-builder（详见下文「Electron 集成」）
- **状态管理**：Pinia（每会话独立 store 实例，settings 全局共享）
- **多会话布局**：dockview-core（`dockview-vue`）——会话面板可拖动停靠、并排对比多设备数据流
- **UI 组件库**：Naive UI（zhCN 中文语言包）
- **国际化**：vue-i18n（`@intlify/unplugin-vue-i18n` 预编译，满足 CSP 无 unsafe-eval；zh/en 结构在 `src/i18n.ts` 编译期互检）
- **终端**：xterm.js（`@xterm/xterm` + addon-fit）+ node-pty（本地终端验证通道）
- **波形图**：uPlot（轻量 Canvas 时序图，用于实时信号/数据流可视化）
- **虚拟滚动**：vue-virtual-scroller（大量消息列表高性能渲染）
- **测试**：Vitest + jsdom + `@vue/test-utils` + Playwright CDP 脚本（`verify:terminal/pty/dockview`）
- **注册源**：国内 npm 镜像（`registry.npmmirror.com`），配置在 `.npmrc`
- **代码质量门禁**：`vue-tsc` 类型检查 + ESLint（`npm run lint`，flat config `eslint.config.js`，lint-staged 提交时自动 `--fix`）

## 架构

### 关键抽象 — IoTransport 传输接口

`src/types.ts` 定义了 `IoTransport` 接口（传输无关核心）：串口 / TCP / 本地终端 / mock / 占位驱动统一契约，端点统一用字符串标识，接收用 `onData(cb)` 订阅（返回取消函数）。信号线方法（`getSignals`/`setSignals`/`setBreak`）为可选扩展，非串口传输不实现，store 用可选链访问、UI 按传输类型隐藏。

所有 stores 依赖此接口而非具体实现，切换传输时 store 无需改动。**内置传输经注册表 `src/serial/registry.ts` 注册**（镜像 themes/decoders 模式），后续新传输（udp 等）追加即可。

| 传输 | 文件 | 环境 | 说明 |
| --- | --- | --- | --- |
| `serialport` | `src/serial/SerialPortDriver.ts` | Electron | 通过 IPC 委托主进程 serialport npm 库，返回真实 COM 口名 |
| `webserial` | `src/serial/WebSerialDriver.ts` | 浏览器 | Web Serial API（Chromium 89+），需 HTTPS + 用户授权 |
| `tcp` | `src/serial/TcpDriver.ts` | Electron | TCP client，主进程 `TcpManager`（Node `net`）；浏览器 DEV 放开预览但连接报「TCP 不可用」 |
| `mock` | `src/mock/MockSerialSource.ts` | 浏览器 DEV | 模拟串口数据，可切换场景（AT 应答/二进制帧/压测/modbus/shell 等）；仅 `?mock` 参数触发，不兜底 |
| `pty` | `src/serial/PtyDriver.ts` | Electron | 本地终端（node-pty spawn 真实 shell），开发验证用；`?pty` 参数触发 |
| `unsupported` | `src/serial/UnsupportedDriver.ts` | 不兼容浏览器 | 占位驱动（方法抛错/no-op）；配合 `IncompatibleBrowser` 全屏遮罩引导用户 |

**用户可切换的是「传输类型」**（`TransportType = 'serial' | 'tcp'`，见 ConnectionBar 下拉），`serial` 内部再按环境解析具体后端驱动。**驱动判定优先级**（`resolveDriverType` 纯函数，有单测）：Electron+`?pty` → pty；Electron → serialport；DEV `?mock` → mock；非安全上下文 → unsupported(insecure-context)；浏览器有 Web Serial → webserial；兜底 → unsupported(no-web-serial)。

> mock 仅 DEV 调试用，不对普通用户暴露。浏览器不兼容时**不再兜底 mock**，而是由 `src/components/IncompatibleBrowser.vue` 全屏阻断遮罩引导用户切换/升级浏览器或改用 HTTPS，避免普通用户误把模拟数据当成真实串口流量。

### 会话架构（session）

`src/session/index.ts` 的 `createSession()` 组装一个自包含会话：每会话独立驱动实例 + **store 八件套**（serial/messages/pause/waveform/recorder/transfer/terminal/dashboard），`settings` 为全局共享的同一 proxy。整个创建包在 detached `effectScope` 中，`dispose()` 统一清理 watcher 与各 store 的 `onScopeDispose` 资源（定时器/订阅/驱动句柄）。

- **视图**：`App.vue` 用根级 dockview 承载会话面板（id `session:<id>`），面板可拖动停靠并排；聚焦哪个面板，全局操作就作用于哪个会话（`useActiveSession`）。
- **端口占用提示**：`provideOccupiedPorts` 收集已连接端口，其他会话 ConnectionBar 下拉禁用+红色提示，防误连。
- **对话框绑定**：根层对话框（设置/文件传输/ASCII 表）记录 opener 会话，切 tab 不影响已打开的对话框。
- **按端口持久化**：帧解码配置（`decoder-config:<port>`）与仪表盘 widget（`dashboard-config:<port>`）按 `serial.selectedPort` 载入/写回；首个端口且无已存配置时沿用内存态并落盘（避免「先选解码器再连接」被端口切换清掉）。

### 数据流

所有串口字节数据以 `Uint8Array` 格式存储一次。ASCII/HEX 视图按需计算（切换视图无需重建数据）。高频数据通过 `requestAnimationFrame` 批处理摄入到 messages store，避免压垮 Vue 响应式系统。

帧解码链路：`serial.onData → messages.makeRxMessage`，解码器（`decoders/` 注册表，内置 `field` 字段布局 + `modbus-rtu`）对剥离帧尾分隔符的载荷解码，匹配成功则 `msg.decoded.fields` 叠加字段块渲染，并经 `messages.onDecode` 广播给仪表盘 store（字段最新值表 + 最近一帧快照）。

### 层次结构

```
src/types.ts              — 共享类型（Message、EndpointInfo、IoTransport、QuickCommand、AppSettings、LogLevel、DecoderConfig 等）
src/i18n.ts               — vue-i18n 实例 + 编译期 zh/en 结构互检
src/session/              — 会话工厂：createSession 组装每会话 store 八件套 + 按端口持久化解码/仪表盘配置
src/decoders/             — 帧解码器注册表 + 内置解码器（field / modbus-rtu），decode 为纯函数可单测
src/utils/                — 纯工具函数（hex、encoding、checksum、composer、search、export-*、message-format、
                             ascii-table、baud、download、fonts、knowledge-base、persist、reconnect、size、
                             terminal-hint、text-parser、usb-vendors、waveform-parser、log-level）—— 无框架依赖
src/utils/logger.ts       — 渲染进程 Logger 单例（IDB 持久化 + console 劫持 + window 全局错误兜底 + 日志导出）
src/mock/                 — MockSerialSource + 场景生成器
src/serial/               — 传输驱动工厂 + 注册表 + WebSerialDriver + SerialPortDriver + TcpDriver + PtyDriver
src/main/                 — Electron 主进程（SerialPortManager、TcpManager、PtyManager、JsonStore、logger）
src/preload/              — Electron 预加载（contextBridge 暴露 serial/tcp/recorder/platform API）
src/composables/          — Vue composables（useFrameSplitter、useSendHistory、useStorage、useMessageSearch、
                             useTheme、useFileWriter、useRecordDirectory、useSession）
src/stores/               — Pinia stores（serial、messages、pause、waveform、recorder、transfer、terminal、dashboard、commands、settings）
src/themes/               — 主题注册表 + 内置主题（glass-industrial-dark/light、oled-hud）
src/locales/              — 国际化文案（zh-CN、en-US）
src/components/           — 25 个 Vue 组件（ConnectionBar、SessionPanel、SessionTab、MessagePanel、MessageBubble、
                             FileTransferBubble、TerminalPane、DashboardPane、DecoderSettingsModal、WaveformChart、
                             InputComposer、QuickCommandsPanel、SettingsModal、StatusBar、MenuBar、KnowledgeBaseModal、
                             AsciiTable、ExportDialog、FileTransferDialog、SendHistoryPopover、MessageList、
                             IncompatibleBrowser、ViewTab、TerminalInput、SessionPane）
src/styles/               — CSS 变量（tokens.css）、基础重置（base.css）、玻璃质感（glass.css）、字体（fonts.css）、dockview 覆写（dockview.css）
src/App.vue               — 根布局：dockview 多会话 + 主题切换 + 右侧快速命令侧栏
src/main.ts               — createApp + Pinia + i18n + 日志初始化 + 主题首帧应用 + 挂载
```

### 组件 ↔ Store 依赖关系

```
App.vue → 会话管理（dockview）+ 所有 stores + useTheme
SessionPanel/SessionTab → useSession（活动会话 + 会话列表）
ConnectionBar   → serial store、recorder store、decoder config
MessagePanel    → messages store、settings store、useMessageSearch、useSession
  └─ MessageBubble → hex/utils、encoding/utils、checksum/utils、search/utils、decoders
  └─ FileTransferBubble → transfer store
  └─ DashboardPane → dashboard store
TerminalPane    → terminal store、serial store、settings store
InputComposer   → serial store、settings store、useSendHistory
  └─ SendHistoryPopover → useSendHistory
QuickCommandsPanel → commands store、serial store
SettingsModal   → settings store、serial store
DecoderSettingsModal → decoder registry、session.decoder
StatusBar       → serial store、messages store、transfer store
WaveformChart   → waveform store、messages store、settings store
ExportDialog    → messages store、settings store
FileTransferDialog → transfer store、settings store
AsciiTable      → ascii-table/utils
KnowledgeBaseModal → knowledge-base/utils
```

### 帧分割

`useFrameSplitter.ts` 是一个纯逻辑类（无定时器，可独立测试），通过三种策略将原始字节流拆分为离散帧：间隔超时、分隔符、固定长度。

### 存储抽象

`useStorage.ts` 封装 localStorage，暴露 `{ get, set, remove }` 接口（同步读源，首次加载零闪烁）。用户数据（设置/命令/波特率/导出偏好/录制目录/解码与仪表盘配置）经 `src/utils/persist.ts` 的 `persistNow` 直写落盘：同步写 localStorage + 异步镜像（浏览器 → IndexedDB `kart-persist`；Electron → 主进程 `JsonStore` 的 `userData/kart-settings.json`）+ 容量自检（≥1.5MB 快照导出提醒）。布局/临时键（rightWidth/inputHeight/sendHistory）仍走同步 `useStorage`。

## 功能总览

- **多会话并排**：dockview 可停靠布局，每会话独立驱动 + store 八件套，可同时连接多设备并排对比；末会话不可关闭；被占用端口下拉禁用提示。
- **端口占用标记**：枚举时主进程对每端口尝试独占打开探测（`dtr:false/rts:false`、成功立即关闭、1s 超时兜底），锁定类打开失败（lock/busy/access is denied 等）判定为被其他程序占用 → 下拉禁用 + 红色「被其他程序占用」，与会话间「已被其他会话占用」区分；权限不足/设备不存在等非锁定错误不判 busy，端口保持可选、连接时报真实错误；`refreshPorts` 自动选中跳过 busy 端口。busy 为枚举时瞬时快照，需刷新端口重新探测；Web Serial 无此能力。
- **收发气泡**：RX 左/TX 左右分色，时间戳精确到毫秒、字节数、帧间 Δt、校验失败标记，悬停可复制/复制为 HEX/重发/添加标注/插入分隔线，暂停时数据不缓冲并显示缺失区间。超长帧两档截断（>4096B 折叠仅预览 512B，展开/收起）。
- **ASCII ↔ HEX 切换**：原始字节只存一份，切视图即时重排。HEX 视图 16 字节/行 + ASCII 透视列。
- **搜索**：文本/HEX 双模式、命中高亮（原生配对）、上一项/下一项导航、当日时间范围筛选。不支持正则。
- **帧解码器**：内置字段布局解析器（u8/u16/u32 等格式、偏移/长度校验防越界）+ Modbus RTU（请求/响应判别按 byteCount 一致性优先、异常响应解析），帧上叠加字段块；解码器注册表可扩展（未来 JS 脚本解码器可复用同一契约）。配置会话级按端口持久化，ConnectionBar 弹窗编辑，`id=''` 表示不启用。
- **仪表盘**：解码器字段驱动（`decoderId:fieldName:index` 绑定），widget 类型 digital（数字表+阈值着色）/led（状态灯）/field-table（最近一帧字段总览），阈值判定为纯函数 `fieldStatus`（alarm 优先 warn，可单测）；widget 拖拽排序、按端口持久化，暂停时自动冻结。
- **发送**：行尾符可选、循环发送（周期 + 次数）、Enter 发送、Ctrl+↑/↓ 翻历史、HEX 输入容错解析（`AA 55`/`0xAA,0x55`/`aa55`）、发送时自动计算校验和（CRC16-Modbus/SUM8/XOR8/CRC32，取会话默认）。
- **校验和**：发送/接收校验配置会话级按端口持久化（`session.checksum`，`ChecksumConfig`），ConnectionBar 弹窗编辑（ChecksumSettingsModal），多会话可各配各的校验方式；RX 校验算法独立于发送侧（支持收发不对称协议），校验前自动剥离帧尾分隔符。旧全局设置经 settings store 七次迁移播种首端口。
- **信号控制（DTR/RTS/Break）**：StatusBar 信号区可切换 DTR/RTS 电平、发送 Break 脉冲（250ms，TX 拉低），用于 ESP32/STM32 bootloader / 复位 / ISP。断开时禁用，自动重连后重放上次电平。链路：`IoTransport.setSignals/setBreak` → Web Serial `port.setSignals` / Electron IPC → 主进程 `port.set({ dtr/rts/brk })`；mock 记录状态供测试断言。
- **自动重连**：设置「掉线自动重连」开启后，驱动检测到物理掉线（`driver.isOpen` 转 false，非用户主动断开）即按固定 2s 间隔无限次重试连接；重连前刷新端口确认设备归位（`WebSerialDriver.listPorts` 重新拉取 `getPorts()` 自愈拔插后的授权端口列表）。用户断开/切驱动标记原因不重连，关闭开关立即取消挂起重连。状态栏橙色 LED + 倒计时指示，重连成功弹一次 toast。判定集中在纯函数 `src/utils/reconnect.ts`（有单测）。
- **TCP 传输**：Electron 主进程 `TcpManager`（Node `net`）经 IPC 暴露，TcpDriver 实现 `IoTransport`；支持 IPv6 校验、同端点并发用 connId 区分、断连窗口处理。终端直通提示仅 TCP 传输渲染（设备回显无歧义，串口不提示）。
- **终端模式**：xterm.js 渲染（cell 网格/光标/ANSI/alt-screen/滚动区域等全能力，vim/nano 全屏可用）。传输模式 line（本地行编辑 Enter 发送）/char（按键直通设备侧回显），本地回显/退格字节（del 0x7F/bs 0x08）/行尾符/回滚上限可配；pty 数据源强制 UTF-8（忽略用户编码设置）。设置：字号缩放、终端字体。
- **快速命令**：增删改、拖拽排序、JSON 导入导出、点击直发、调到发送框；每条命令可独立配置校验和（inherit 会话默认或覆盖）。
- **文件发送**：分包切片、三种协议封装（raw/len-prefix/seq-crc）、限速（字节速率 + 包间延时，取更严者）、ACK 流控（any/byte/echo-crc + 超时/NACK 重试）、循环下发、断点续传、错误注入（破坏 CRC/跳过 ACK）、断线自动中止。`FileTransferDialog` 预设（原始整包/STM32-ISP/ESP32/压测/自定义）+ 拖拽；限速输入框实时显示波特率对应物理层上限。
- **波形图**：实时 Canvas 时序图（uPlot），多通道自动检测（无标签数值行按 token 扩容 / `label:value` 按标签分配），游标读值、双游标 Δ、V/div & ms/div 时基、触发线、每通道自定义颜色、暂停回看、CSV 导出。仅文本行解析（Arduino Serial.println 风格），无二进制解析模式。
- **录制**：原始字节流目录式录制成文件（txt 带时间戳 HEX 行 / csv 四列），格式/位置可配，断线自动停止，pagehide 自动落盘；文件名含端口（多会话并排区分数据来源）。
- **标注与导出**：帧标注 📌、分隔线（可带标签）；导出 TXT/CSV/JSON/Binary 四种格式 + 筛选 + hex/ascii 双列 + 「包含分隔线/标注」选项。波形 CSV、快速命令 JSON 导入导出。
- **ASCII 对照表**：右侧抽屉，点击行插入到发送框。
- **帮助**：知识库（常见问题/百科，i18n 驱动）、快捷键面板、应用日志导出。
- **设置**：编码（UTF-8/ASCII/GBK）、帧策略、缓冲上限、默认视图、主题（亮/暗）、字号、终端字体（Local Font Access 枚举系统字体）与字号缩放、录制格式与目录、暂停恢复提示开关。校验算法已移出全局设置（会话级，见上方「校验和」）。
- **统计**：帧数（RX/TX）、帧速率（f/s）、字节速率（B/s）、会话时长、缓冲使用率（>80% 告警）、校验失败计数、丢弃帧/采样提示。
- **应用日志**：面向用户报障。浏览器端写 IndexedDB；Electron 下主进程按日轮转文件日志（`userData/logs/YYYY-MM-DD.log`，保留 30 天）并汇聚渲染端全部 console。文件菜单「导出日志」一键下载：Electron 优先取主进程文件（权威来源），浏览器取 IDB，导出文件头自动附带版本/平台/驱动等环境信息。级别/行格式/level 映射集中在纯函数 `src/utils/log-level.ts`（两端共用、有单测）。
- **状态栏**：连接态、传输参数概要、RX/TX/帧/ERR 统计、CTS 只读指示（状态圆点）、DTR/RTS/BRK 控制、活跃文件下发紧凑条。
- **主题**：多主题注册表 + 3 套内置主题（glass-industrial-dark、glass-industrial-light、oled-hud），明暗二元，无"跟随系统"。

## Electron 集成

桌面打包基于 **vite-plugin-electron**（单 vite 配置，由环境变量 `ELECTRON=true` 开关）。普通 `npm run dev` / `npm run build` 不设该变量，插件完全惰性，浏览器构建产物与无 Electron 时一致。

- `src/main/index.ts` — 主进程：创建 `BrowserWindow`（`contextIsolation: true`、`nodeIntegration: false`）；dev 下 `loadURL(VITE_DEV_SERVER_URL)`，prod 下 `loadFile(dist/index.html)`；初始化 `SerialPortManager`/`TcpManager`/`PtyManager`/`JsonStore` 并注册 IPC handlers（`serial:*`、`tcp:*`、`pty:*`、`recorder:*`）。
- `src/main/SerialPortManager.ts` — 封装 serialport npm 库：枚举串口（返回真实 COM 口名如 `COM5`、`/dev/cu.usbserial-1420`；macOS 上 serialport 枚举的是 dialin 节点 `/dev/tty.*`，已换算为惯例的 callout 节点 `/dev/cu.*`）、多端口并发（`Map<path, PortEntry>`，同端口二次 open 拒绝）、打开/关闭/写入/信号状态。读取事件驱动（`SerialPort 'data'` 事件），通过 `webContents.send` 推送到渲染进程。
- `src/main/TcpManager.ts` — TCP 客户端（Node `net`），IPv6 校验、`connId` 区分同端点并发连接。
- `src/main/PtyManager.ts` — node-pty 封装，spawn 本地 shell 作为「串口设备」。
- `src/main/JsonStore.ts` — 持久化后备（`userData/kart-settings.json`）：防抖 500ms + 原子写 + will-quit 同步刷盘。
- `src/preload/index.ts` — 预加载：通过 contextBridge 暴露 `serial`（listPorts/open/close/write/getSignals/setSignals/setBreak/onData/onError）、`tcp`、`recorder`（showDirectoryPicker/createFile/writeChunk/closeFile）、`platform`。渲染进程不直接接触原生库 —— 保持 contextIsolation 安全模型。
- `src/serial/SerialPortDriver.ts` — 渲染端驱动：实现 `IoTransport` 接口，通过 `window.electron.serial` 与主进程 IPC 通信。信号轮询 500ms。
- `vite.config.ts` — `base` 在 Electron 目标下设为 `'./'`（file:// 加载需相对路径），浏览器下为 `'/'`。
- `tsconfig.node.json` — 主/预加载的 Node 上下文类型检查（无 DOM lib），`electron:build` 中以 `tsc -p tsconfig.node.json --noEmit` 作为门禁。
- `electron-builder.json` — 打包配置，输出到 `release/`（三平台：Windows NSIS、macOS DMG/ZIP、Linux AppImage/deb）。
- 主/预加载强制以 **CommonJS（`.cjs`）** 输出（见 `vite.config.ts` 中 main 的 `lib:false` + `rollupOptions`）：`package.json` 为 `type:module`，若以 ESM 导入 CJS 的 `electron` 模块会触发 Node ESM 互操作错误。
- 浏览器构建与 Electron 渲染构建都写入 `dist/`，是两个独立命令，后构建覆盖前者。

### macOS / Linux Electron 二进制下载

首次 `npm install` 后运行 `electron:dev` 可能报 `Electron failed to install correctly`，原因是 npm 11+ **不再将 `.npmrc` 中未知的 config key 注入为环境变量**，导致 `@electron/get` 读取不到 `electron_mirror` 镜像地址，下载静默失败。

**症状**：
- `node_modules/electron/path.txt` 缺失
- `node_modules/electron/dist/version` 缺失
- macOS：`dist/Electron.app` 存在但只有 49KB stub，缺少 `Frameworks/Electron Framework.framework`
- Linux：`dist/electron` 二进制很小或不存在
- `require('electron')` 抛出 `Electron failed to install correctly`

**修复**：

```sh
# 1. 确认 approve-scripts（否则 postinstall 被 npm 安全策略拦截）
npm approve-scripts electron

# 2. 设镜像变量并重新安装
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install electron@31.7.7

# 3. 若仍失败，直接手动下载并解压
rm -rf node_modules/electron/dist node_modules/electron/path.txt ~/Library/Caches/electron/

# macOS (arm64)
curl -L -o /tmp/electron-v31.7.7-darwin-arm64.zip \
  "https://npmmirror.com/mirrors/electron/31.7.7/electron-v31.7.7-darwin-arm64.zip"
mkdir -p node_modules/electron/dist
unzip -o /tmp/electron-v31.7.7-darwin-arm64.zip -d node_modules/electron/dist/
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
printf '%s' '31.7.7' > node_modules/electron/dist/version

# Linux (x64)
curl -L -o /tmp/electron-v31.7.7-linux-x64.zip \
  "https://npmmirror.com/mirrors/electron/31.7.7/electron-v31.7.7-linux-x64.zip"
mkdir -p node_modules/electron/dist
unzip -o /tmp/electron-v31.7.7-linux-x64.zip -d node_modules/electron/dist/
printf 'electron' > node_modules/electron/path.txt
printf '%s' '31.7.7' > node_modules/electron/dist/version
```

`allowScripts` 配置已写入 `package.json`，未来新 clone 项目时 `npm install` 会自动触发 electron 的 postinstall 下载。

### 本地终端验证（node-pty）

终端模式（xterm）的**无硬件验证途径**：在 Electron 内用 **node-pty** 直接 spawn 本地 shell，把真实 zsh/bash 作为「串口设备」连到终端视图，可验证真实行编辑、ANSI 色彩、**vim/nano 全屏**（这是 mock shell 场景做不到的）。

- **手动体验**：`KART_PTY=1 npm run electron:dev`。主进程给 URL 追加 `?pty`，渲染端 `resolveDriverType` 命中 `pty` 驱动（端口下拉出现「本地终端」，连接即 spawn 本地 shell）。
- **自动化验证**：`ELECTRON=true vite build && npm run verify:pty`（`scripts/verify-pty.mjs`，Playwright CDP 驱动 Electron，连接 → 终端视图 → `ls` 回显 → `vim` 全屏 → 无 console 错误，截图在 `/tmp/pty-verify/`）。
- **驱动链路**：主进程 `PtyManager`（node-pty spawn）→ IPC `pty:data` → 预加载 → 渲染端 `PtyDriver`（实现 `IoTransport`，`setSize` 同步窗口尺寸给 shell 的 stty）→ serial store → terminal store（xterm 薄桥）。

**node-pty 需本地编译**：npm 发布的 prebuilt 与当前 macOS 不兼容，`spawn` 报 `posix_spawnp failed`（无 errno）。解决：`cd node_modules/node-pty && npx node-gyp rebuild`。node-pty 用 N-API，编译产物 Node/Electron 通用（Electron 31 直接可用）。已自动化：`postinstall` 钩子 `scripts/check-node-pty.mjs` 会真实 spawn 探测一次 binding，损坏/缺失时自动 rebuild——新 clone 后 `npm install` 无需手动干预。手动路径仍可用作兜底。

**`ELECTRON_RUN_AS_NODE` 也影响 `verify:pty`**：脚本 spawn Electron 前已 `delete process.env.ELECTRON_RUN_AS_NODE`（同 start-electron.mjs 的防御）。

**构建压缩必须用 terser（勿改回 esbuild）**：vite 默认 esbuild 对整个 bundle 压缩时重命名冲突，会破坏 xterm.js 6.0.0 的 `requestMode`——真实终端（zsh/vim）发送 DECRQM/模式序列时抛 `ReferenceError: r is not defined`，vim 全屏无法渲染（dev 模式不压缩不触发，故 mock 测试没暴露）。`vite.config.ts` 已设 `build.minify: 'terser'`（体积 1.3MB，与 esbuild 相当）。改回 esbuild 会重新引入该 bug。

### 本机环境注意点（Windows）
- **`ELECTRON_RUN_AS_NODE`**：本机全局设置了该变量为 `1`（疑似 STM32 等工具链所致），会让所有 Electron 退化为纯 Node 运行（`electron --version` 返回 Node 版本，`require('electron')` 只得到可执行文件路径）。Electron 按「变量是否存在」判断，置空/置 0 均无效，必须删除。项目已防御处理：`vite.config.ts` 在 Electron 分支删除它（覆盖 `electron:dev` 插件 spawn），`scripts/start-electron.mjs` 在 `electron:preview` 启动前删除它。根治办法是从系统环境变量中移除该项。
- **`electron:build` 首次打包的 winCodeSign 解压**：electron-builder 解压 `winCodeSign` 归档时需创建 macOS 符号链接，Windows 非管理员且未开启「开发者模式」会因权限失败（`客户端没有所需的特权`）。该归档里的 darwin 文件仅用于 macOS 签名，与 Windows 打包无关。解决：开启 Windows 开发者模式（或以管理员运行）后重跑；或手动把归档解压到缓存 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`（排除 `darwin` 目录）再重跑。未做代码签名，安装包会触发 SmartScreen 警告，属正常。

### 本机环境注意点（Linux / WSL）
- **系统依赖**：Linux 下 Electron 需要 GTK、libnotify、libnss 等原生库。Debian/Ubuntu 系（含 WSL）执行：
  ```sh
  sudo apt install -y libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
  ```
- **WSL 图形支持**：WSL2 + WSLg（Windows 11）可直接运行 Electron 窗口。旧版 WSL 或无 WSLg 的环境需配置 X server（如 VcXsrv），且附加 `--no-sandbox` 参数。
- **`electron:build` 打包目标**：当前配置为 `AppImage`（通用单文件）和 `deb`（Debian/Ubuntu），可在 Linux 下直接构建。若在 WSL 中构建 Windows NSIS 安装包，需额外安装 `wine`（electron-builder 依赖它处理 `.exe`）。
- **镜像下载**：与前文 macOS 节描述相同，Linux 同样受 npm 11+ 不传递 `.npmrc` 环境变量的问题影响，修复方法一致。注意平台后缀不同（`linux-x64.zip` vs `darwin-arm64.zip`）。

## 待完成事项

1. 将 Blob 下载替换为 Electron `dialog` + `fs`（快照导出已走 dialog，其余下载路径未接）
2. 文件发送引擎内联工具（crc/chunk-framer/rate-limit）拆分为独立 `utils/*.ts` + 单测
3. 快速命令变量/宏替换（计数器、时间戳、CRC 占位）未实现（`QuickCommand.payload` 静态）
4. 波形二进制解析模式已移除（仅文本行解析），未来重引入时重新评估时间对齐

## 生产环境缺失功能与已知问题

生产化待补功能（按优先级分层）与已知技术问题汇总在 [docs/production-gaps.md](docs/production-gaps.md)，供后续任务规划参考。设计文档见 [docs/](./docs/)（multi-session-ui、terminal-mode、dashboard、file-transfer、multi-port、theme-system）。
