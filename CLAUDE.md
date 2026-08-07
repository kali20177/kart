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
```

## 项目概览

串口调试助手 —— 面向嵌入式开发调试的现代化串口工具。Vue 3 SPA，三种串口驱动可切换，同一份代码同时支持浏览器（Web Serial API）和 Electron 桌面应用（serialport npm 库），打包输出 Windows/macOS/Linux 三平台安装包。

- **框架**：Vue 3（`<script setup>` Composition API）
- **构建**：Vite 5、TypeScript strict、`@/` 路径别名 → `src/`
- **桌面打包**：Electron 31 + vite-plugin-electron + electron-builder（详见下文「Electron 集成」）
- **状态管理**：Pinia
- **UI 组件库**：Naive UI（zhCN 中文语言包）
- **国际化**：vue-i18n（`@intlify/unplugin-vue-i18n` 预编译，满足 CSP 无 unsafe-eval）
- **波形图**：uPlot（轻量 Canvas 时序图，用于实时信号/数据流可视化）
- **虚拟滚动**：vue-virtual-scroller（大量消息列表高性能渲染）
- **测试**：Vitest + jsdom + `@vue/test-utils`
- **注册源**：国内 npm 镜像（`registry.npmmirror.com`），配置在 `.npmrc`
- **代码质量门禁**：`vue-tsc` 类型检查 + ESLint（`npm run lint`，flat config `eslint.config.js`，lint-staged 提交时自动 `--fix`）

## 架构

### 关键抽象 — SerialDriver 接口

`src/types.ts` 定义了 `SerialDriver` 接口。所有 Pinia stores 依赖此接口而非具体实现，切换驱动时 store 无需改动。

**驱动实现，通过工厂 `src/serial/index.ts` 运行时自动选择：**

| 驱动 | 文件 | 环境 | 说明 |
| --- | --- | --- | --- |
| `mock` | `src/mock/MockSerialSource.ts` | 浏览器 DEV | 模拟串口数据，可切换场景（AT 应答/二进制帧/压测等）；仅 `?mock` 参数触发，不兜底 |
| `webserial` | `src/serial/WebSerialDriver.ts` | 浏览器 | Web Serial API（Chromium 89+），需 HTTPS + 用户授权 |
| `serialport` | `src/serial/SerialPortDriver.ts` | Electron | 通过 IPC 委托主进程 serialport npm 库，返回真实 COM 口名 |
| `unsupported` | `src/serial/UnsupportedDriver.ts` | 不兼容浏览器 | 占位驱动（方法抛错/no-op）；配合 `IncompatibleBrowser` 全屏遮罩引导用户 |

**驱动选择优先级：** Electron 环境 → serialport；DEV 模式 `?mock` 查询参数 → mock；非安全上下文 → unsupported（全屏遮罩提示改用 HTTPS / localhost）；浏览器有 Web Serial → webserial；兜底 → unsupported（全屏遮罩提示切换/升级浏览器）。运行环境自动确定驱动，无需用户手动选择。

> mock 仅 DEV 调试用，不对普通用户暴露。浏览器不兼容时**不再兜底 mock**，而是由 `src/components/IncompatibleBrowser.vue` 全屏阻断遮罩引导用户切换/升级浏览器或改用 HTTPS，避免普通用户误把模拟数据当成真实串口流量。判定逻辑见 `resolveDriverType`（纯函数，有单测）。

### 数据流

所有串口字节数据以 `Uint8Array` 格式存储一次。ASCII/HEX 视图按需计算（切换视图无需重建数据）。高频数据通过 `requestAnimationFrame` 批处理摄入到 messages store，避免压垮 Vue 响应式系统。

### 层次结构

```
src/types.ts              — 共享类型（Message、PortOptions、SerialDriver、QuickCommand、AppSettings、LogLevel 等）
src/utils/                — 纯工具函数（hex、encoding、checksum、byte-parser、search、export-*、message-format、ascii-table、baud、download、log-level）—— 无框架依赖
src/utils/logger.ts       — 渲染进程 Logger 单例（IDB 持久化 + console 劫持 + window 全局错误兜底 + 日志导出）
src/mock/                 — MockSerialSource + 场景生成器
src/serial/               — 串口驱动工厂 + WebSerialDriver + SerialPortDriver（Electron IPC）
src/main/                 — Electron 主进程（SerialPortManager — 封装 serialport 库；logger.ts — 按日轮转的文件日志）
src/preload/              — Electron 预加载（contextBridge 暴露 serial/recorder/platform API）
src/composables/          — Vue composables（useFrameSplitter、useSendHistory、useStorage、useMessageSearch、useTheme、useFileWriter、useRecordDirectory）
src/stores/               — Pinia stores（serial、messages、commands、settings、recorder、transfer、waveform）
src/themes/               — 主题注册表 + 内置主题（glass-industrial-dark/light、oled-hud）
src/locales/              — 国际化文案（zh-CN、en-US）
src/components/           — 14 个 Vue 组件（ConnectionBar、MenuBar、MessageList、MessageBubble、
                            InputComposer、SendHistoryPopover、QuickCommandsPanel、SettingsModal、
                            StatusBar、AsciiTable、ExportDialog、FileTransferDialog、FileTransferBubble、
                            WaveformChart）
src/styles/               — CSS 自定义属性（亮/暗主题令牌 + 基础重置）
src/App.vue               — 根布局 + 主题切换 + 双栏/三栏布局
src/main.ts               — createApp + Pinia + i18n + 挂载
```

### 组件 ↔ Store 依赖关系

```
App.vue → 所有 stores + useTheme
MenuBar         → settings store（亮/暗切换、i18n 语言切换）
ConnectionBar   → serial store、recorder store
MessageList     → messages store、settings store、useMessageSearch
  └─ MessageBubble → hex/utils、encoding/utils、checksum/utils、search/utils
  └─ FileTransferBubble → transfer store
InputComposer   → serial store、settings store、useSendHistory
  └─ SendHistoryPopover → useSendHistory
QuickCommandsPanel → commands store、serial store
SettingsModal   → settings store、serial store
StatusBar       → serial store、messages store、transfer store
WaveformChart   → waveform store、messages store、settings store
ExportDialog    → messages store、settings store
FileTransferDialog → transfer store、settings store
AsciiTable      → ascii-table/utils
```

### 帧分割

`useFrameSplitter.ts` 是一个纯逻辑类（无定时器，可独立测试），通过三种策略将原始字节流拆分为离散帧：间隔超时、分隔符、固定长度。

### 存储抽象

`useStorage.ts` 封装 localStorage，暴露 `{ get, set, remove }` 接口（同步读源，首次加载零闪烁）。用户数据（设置/命令/波特率/导出偏好/录制目录）经 `src/utils/persist.ts` 的 `persistNow` 直写落盘：同步写 localStorage + 异步镜像（浏览器 → IndexedDB `kart-persist`；Electron → 主进程 `JsonStore` 的 `userData/kart-settings.json`）+ 容量自检（≥1.5MB 快照导出提醒）。布局/临时键（rightWidth/inputHeight/sendHistory）仍走同步 `useStorage`。

## 功能总览

- **收发气泡**：RX 左/TX 左右分色，时间戳精确到毫秒、字节数、帧间 Δt、校验失败标记，悬停可复制/复制为 HEX/重发/添加标注，暂停时数据不缓冲并显示缺失区间。
- **ASCII ↔ HEX 切换**：原始字节只存一份，切视图即时重排。HEX 视图 16 字节/行 + ASCII 透视列。
- **搜索**：文本/HEX 双模式、命中高亮（原生配对）、上一项/下一项导航、当日时间范围筛选。不支持正则。
- **发送**：行尾符可选、循环发送（周期 + 次数）、Enter 发送、Ctrl+↑/↓ 翻历史、HEX 输入容错解析、发送时自动计算校验和（CRC16-Modbus/SUM8/XOR8/CRC32）。
- **接收校验**：独立 RX 校验算法（不耦合发送侧），支持收发不对称协议，分隔符前自动校验。
- **信号控制（DTR/RTS/Break）**：StatusBar 信号区可切换 DTR/RTS 电平、发送 Break 脉冲（250ms，TX 拉低），用于 ESP32/STM32 bootloader / 复位 / ISP。断开时禁用，自动重连后重放上次电平。链路：`SerialDriver.setSignals/setBreak` → Web Serial `port.setSignals` / Electron IPC → 主进程 `port.set({ dtr/rts/brk })`；mock 记录状态供测试断言。
- **自动重连**：设置「掉线自动重连」开启后，驱动检测到物理掉线（`driver.isOpen` 转 false，非用户主动断开）即按固定 2s 间隔无限次重试连接；重连前刷新端口确认设备归位（`WebSerialDriver.listPorts` 重新拉取 `getPorts()` 自愈拔插后的授权端口列表，连通 Web Serial 的断插重连）。用户断开/切驱动标记原因不重连，关闭开关立即取消挂起重连。状态栏橙色 LED + 倒计时指示「重连中…」，重连成功弹一次 toast。判定集中在纯函数 `src/utils/reconnect.ts`（有单测），store 与组件共用同一套。
- **快速命令**：增删改、拖拽排序、JSON 导入导出、点击直发、调到发送框；每条命令可独立配置校验和（inherit 全局或覆盖）。
- **文件发送**：分包切片、三种协议封装（raw/len-prefix/seq-crc）、限速、ACK 流控、循环下发、断点续传、错误注入。`FileTransferDialog` 预设（原始整包/STM32-ISP/ESP32/压测/自定义）+ 拖拽。
- **波形图**：实时 Canvas 时序图（uPlot），多通道色相均分，支持暂停/恢复、时间范围选择、CSV 导出。
- **录制**：原始字节流目录式录制成文件（格式/位置可配），支持开始/停止，pagehide 自动落盘。
- **ASCII 对照表**：右侧抽屉，点击行插入到发送框。
- **设置**：编码（UTF-8/ASCII/GBK）、帧策略、缓冲上限、默认视图、主题（亮/暗）、字号、发送/接收校验算法、录制格式与目录。
- **统计**：帧数（RX/TX）、帧速率（f/s）、字节速率（B/s）、会话时长、缓冲使用率（>80% 告警）、校验失败计数。
- **导出**：消息列表 CSV/JSON 导出、波形 CSV 导出、快速命令 JSON 导入导出。
- **应用日志**：面向用户报障。浏览器端写 IndexedDB；Electron 下主进程按日轮转文件日志（`userData/logs/YYYY-MM-DD.log`，保留 30 天）并汇聚渲染端全部 console（`console-message` 事件转发）。文件菜单「导出日志」一键下载：Electron 优先取主进程文件（权威来源，含主进程事件），浏览器取 IDB，导出文件头自动附带版本/平台/驱动等环境信息。关键生命周期均有埋点：驱动选择、连接/断连（含会话时长与流量）、写入失败、录制、文件传输、全局错误。级别/行格式/level 映射集中在纯函数 `src/utils/log-level.ts`（两端共用、有单测）。
- **状态栏**：连接态、端口参数概要、RX/TX/帧/ERR 统计、CTS 只读指示（状态圆点，表示对端允许发送）、DTR/RTS/BRK 控制、活跃文件下发紧凑条。
- **主题**：多主题注册表 + 3 套内置主题（glass-industrial-dark、glass-industrial-light、oled-hud），明暗二元，无"跟随系统"。

## Electron 集成

桌面打包基于 **vite-plugin-electron**（单 vite 配置，由环境变量 `ELECTRON=true` 开关）。普通 `npm run dev` / `npm run build` 不设该变量，插件完全惰性，浏览器构建产物与无 Electron 时一致。

- `src/main/index.ts` — 主进程：创建 `BrowserWindow`（`contextIsolation: true`、`nodeIntegration: false`）；dev 下 `loadURL(VITE_DEV_SERVER_URL)`，prod 下 `loadFile(dist/index.html)`；初始化 `SerialPortManager` 并注册 IPC handlers（`serial:list-ports`、`serial:open`、`serial:close`、`serial:write`、`serial:get-signals`、`serial:set-signals`、`serial:set-break`）。
- `src/main/SerialPortManager.ts` — 封装 serialport npm 库：枚举串口（返回真实 COM 口名如 `COM5`、`/dev/cu.usbserial-1420`；macOS 上 serialport 枚举的是 dialin 节点 `/dev/tty.*`，已换算为惯例的 callout 节点 `/dev/cu.*`）、打开/关闭/写入/信号状态（`getSignals` + `setSignals`/`setBreak`）。读取事件驱动（`SerialPort 'data'` 事件），通过 `webContents.send` 推送到渲染进程。相比手写 C++ addon：无需本机工具链、prebuilt native bindings、跨平台。
- `src/preload/index.ts` — 预加载：通过 contextBridge 暴露 `serial`（listPorts/open/close/write/getSignals/setSignals/setBreak/onData/onError）、`recorder`（showDirectoryPicker/createFile/writeChunk/closeFile）、`platform`。渲染进程不直接接触原生库 —— 保持 contextIsolation 安全模型。
- `src/serial/SerialPortDriver.ts` — 渲染端驱动：实现 `SerialDriver` 接口，通过 `window.electron.serial` 与主进程 IPC 通信。信号轮询 500ms。
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

## 生产环境缺失功能与已知问题

生产化待补功能（按优先级分层）与已知技术问题汇总在 [docs/production-gaps.md](docs/production-gaps.md)，供后续任务规划参考。
