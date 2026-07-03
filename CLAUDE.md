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
npm run electron:build # 类型检查 + 构建 + electron-builder 打包为 Windows 安装包（输出 release/）
npm run electron:preview # 构建后用 electron 直接运行（不打包）
```

## 项目概览

**阶段 1** 串口调试助手 — 浏览器 SPA，使用模拟串口数据。同一份代码已可打包为 Electron 桌面应用（仍跑模拟数据，仅构建/打包脚手架）。**阶段 2** 将接入 Web Serial API 等真实能力。

- **框架**：Vue 3（`<script setup>` Composition API）
- **构建**：Vite 5、TypeScript strict、`@/` 路径别名 → `src/`
- **桌面打包**：Electron 31 + vite-plugin-electron + electron-builder（详见下文「Electron 集成」）
- **状态管理**：Pinia
- **UI 组件库**：Naive UI（zhCN 中文语言包）
- **测试**：Vitest + jsdom + `@vue/test-utils`
- **注册源**：国内 npm 镜像（`registry.npmmirror.com`），配置在 `.npmrc`
- **无 linter/formatter** —— `vue-tsc` 类型检查是唯一的代码质量门禁

## 架构

### 数据流
所有串口字节数据以 `Uint8Array` 格式存储一次。ASCII/HEX 视图按需计算（切换视图无需重建数据）。高频数据通过 `requestAnimationFrame` 批处理摄入到 messages store，避免压垮 Vue 响应式系统。

### 关键抽象 — SerialDriver 接口
`src/mock/MockSerialSource.ts` 定义了 `SerialDriver` 接口，模拟源和未来的 `WebSerialDriver` 都将实现该接口。Pinia stores 依赖此接口而非具体实现——阶段 2 替换模拟源为真实串口时，store 无需任何改动。

### 层次结构
```
src/types.ts              — 共享类型（Message、PortOptions、QuickCommand、AppSettings）
src/utils/                — 纯工具函数（hex、encoding、ascii-table）—— 无框架依赖
src/mock/                 — MockSerialSource + 场景生成器（阶段 2 被替换）
src/composables/          — Vue composables（useFrameSplitter、useSendHistory、useStorage）
src/stores/               — Pinia stores（serial、messages、commands、settings）
src/components/           — 8 个 Vue 组件（ConnectionBar、MessageList、MessageBubble、
                            InputComposer、QuickCommandsPanel、AsciiTable、SettingsDrawer、StatusBar）
src/App.vue               — 根布局 + 主题切换
src/main.ts               — createApp + Pinia + 挂载
src/styles/tokens.css     — CSS 自定义属性（亮/暗主题、字体、间距）
```

### 组件 ↔ Store 依赖关系
```
App.vue → 所有 stores
ConnectionBar   → serial store
MessageList     → messages store, settings store
  └─ MessageBubble → hex/utils, encoding/utils
InputComposer   → serial store, settings store, useSendHistory
QuickCommandsPanel → commands store, serial store
AsciiTable      → ascii-table/utils
SettingsDrawer  → settings store, serial store
StatusBar       → serial store
```

### 帧分割
`useFrameSplitter.ts` 是一个纯逻辑类（无定时器，可独立测试），通过三种策略将原始字节流拆分为离散帧：间隔超时、分隔符、固定长度。

### 存储抽象
`useStorage.ts` 封装 localStorage，暴露 `{ get, set, remove }` 接口。阶段 2 切换到 `electron-store` 时，调用方无需修改。

## Electron 集成

桌面打包基于 **vite-plugin-electron**（单 vite 配置，由环境变量 `ELECTRON=true` 开关）。普通 `npm run dev` / `npm run build` 不设该变量，插件完全惰性，浏览器构建产物与无 Electron 时一致。

- `src/main/index.ts` — 主进程：创建 `BrowserWindow`（`contextIsolation: true`、`nodeIntegration: false`）；dev 下 `loadURL(VITE_DEV_SERVER_URL)`，prod 下 `loadFile(dist/index.html)`。
- `src/preload/index.ts` — 预加载：当前仅占位（暴露 `platform`），阶段 2 在此通过 contextBridge 接入串口/存储。
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

## 阶段 2 路线图
1. ~~添加 Electron + electron-builder~~（已完成：vite-plugin-electron + electron-builder 脚手架）
2. ~~添加 `src/main/`（主进程）和 `src/preload/`（contextBridge）~~（已完成占位）
3. 实现 Web Serial API 的 `SerialDriver`
4. 将 serial store 中的 `MockSerialSource` 替换为真实驱动
5. 将 `useStorage` 从 localStorage 迁移到 electron-store
6. 将 Blob 下载替换为 Electron `dialog` + `fs`

## 生产环境缺失功能与已知问题

生产化待补功能（按优先级分层）与已知技术问题（如 `vite.config` 的 `test.environment` 未生效）汇总在 [docs/production-gaps.md](docs/production-gaps.md)，供后续任务规划参考。