# 串口调试助手 · serial-demo

面向嵌入式开发调试的现代化串口助手。**聊天气泡式**数据收发、**ASCII / HEX** 双视图、**帧分割与校验**、**文件下发**、**波形可视化**、**自定义快速命令**，支持浏览器（Web Serial API）和 Electron 桌面应用（serialport 原生库）。

---

## 技术栈

| 维度 | 选型 |
| --- | --- |
| 构建 | Vite 5 + Vue 3 + TypeScript |
| 状态 | Pinia |
| UI 库 | Naive UI |
| 国际化 | vue-i18n（预编译，CSP 友好） |
| 波形图 | uPlot |
| 虚拟滚动 | vue-virtual-scroller |
| 桌面打包 | Electron 31 + vite-plugin-electron + electron-builder |
| 串口（浏览器） | Web Serial API |
| 串口（Electron） | serialport npm 库（主进程 IPC） |
| 持久化 | localStorage（后续切 electron-store，接口不变） |
| 测试 | Vitest + jsdom |

## 快速开始（已配置国内镜像）

根目录已含 [.npmrc](./.npmrc)，`npm install` 自动走淘宝 npmmirror，无需手动配置。

```bash
npm install        # 安装依赖（走镜像）
npm run dev        # 启动开发服务器 http://localhost:5273
npm run build      # 类型检查 + 生产构建
npm test           # 运行单元测试
```

### Electron 桌面应用

```bash
npm run electron:dev      # Electron 开发模式（HMR + 主进程/预加载自动重启）
npm run electron:build    # 打包为安装包（输出 release/）
npm run electron:preview  # 构建后用 Electron 直接运行（不打包）
```

> Electron 环境下自动使用 serialport 原生库，获取真实 COM 口名（如 `COM5`、`/dev/tty.usbserial-1420`）。首次安装若 Electron 二进制下载失败，参考 [CLAUDE.md](./CLAUDE.md) 中的修复步骤。

## 串口驱动

项目支持三种驱动，运行时自动选择，DEV 模式下可通过 UI 下拉切换：

| 驱动 | 环境 | 实现 |
| --- | --- | --- |
| **SerialPort** | Electron | `serialport` npm 库 → 主进程 IPC → 事件驱动读取，返回真实 COM 口名 |
| **Web Serial** | 浏览器 | Web Serial API（Chromium 89+），需 HTTPS + 用户授权 |
| **Mock** | 浏览器 DEV | 模拟串口数据，可切换场景（AT 应答 / 二进制帧 / 高吞吐压测 / 混合 ASCII） |

> `serialport` 是 Node.js native addon，仅在 Electron 主进程中可用，浏览器沙箱无法运行。因此 Web Serial API 和 serialport 是互补而非替代关系，分别覆盖浏览器和桌面两个使用场景。

## 功能一览

- **聊天气泡收发**：RX 左/TX 右分色，时间戳精确到毫秒、字节数、帧间 Δt、校验失败标记；悬停可复制 / 复制为 HEX / 重发 / 添加标注
- **ASCII ↔ HEX 双视图**：原始字节 `Uint8Array` 只存一份，切视图即时重排不丢数据；HEX 16 字节/行 + ASCII 透视列
- **搜索**：文本 / HEX 双模式、命中高亮、上一项 / 下一项导航、时间范围筛选
- **帧切分**：空闲超时 / 分隔符 / 定长三种策略
- **校验和**：发送自动追加（CRC16-Modbus / SUM8 / XOR8 / CRC32），接收可选校验（独立算法，支持收发不对称协议）
- **发送框**：行尾符、循环发送（周期 + 次数）、HEX 输入容错解析（`AA 55`、`0xAA,0x55`、`aa55` 皆可）、发送历史（Ctrl+↑/↓）
- **快速命令**：增删改、拖拽排序、JSON 导入导出、点击直发；每条命令可独立配置校验和
- **文件下发**：分包切片、三种协议封装（raw / len-prefix / seq-crc-CRC16）、限速（字节速率 + 包间延时）、ACK 流控、循环下发、断点续传
- **波形图**：uPlot 实时 Canvas 时序图，多通道色相均分，暂停/恢复，CSV 导出
- **录制**：原始字节流目录式录制成文件（格式/位置可配，pagehide 自动落盘）
- **ASCII 对照表**：右侧抽屉，点击行插入到发送框
- **设置**：编码（UTF-8 / ASCII / GBK）、帧策略、缓冲上限、默认视图、主题、字号、校验算法、录制配置
- **状态栏**：连接态、端口参数概要、RX/TX/帧/ERR 统计、信号线状态（DCD/CTS/DSR/RI）、文件下发活跃状态
- **实时统计**：帧数/帧速率/字节速率/会话时长/缓冲使用率
- **导出**：消息 CSV/JSON、波形 CSV、快速命令 JSON
- **主题**：3 套内置主题（glass-industrial-dark、glass-industrial-light、oled-hud），亮/暗切换
- **i18n**：简体中文 / English

## 目录结构

```
src/
├── components/       # 14 个 Vue 组件
│   ├── ConnectionBar.vue        # 连接栏：串口选择、波特率、参数、连接/断开
│   ├── MenuBar.vue              # 菜单栏：主题/语言切换
│   ├── MessageList.vue          # 消息列表（虚拟滚动）
│   ├── MessageBubble.vue        # 消息气泡（含文件下发气泡委托）
│   ├── FileTransferBubble.vue   # 文件下发气泡（进度/速率/ETA）
│   ├── InputComposer.vue        # 发送框 + 发送历史弹出层
│   ├── SendHistoryPopover.vue   # 发送历史弹出层
│   ├── QuickCommandsPanel.vue   # 快速命令面板
│   ├── SettingsModal.vue        # 设置面板
│   ├── StatusBar.vue            # 状态栏（信号线/统计/文件下发）
│   ├── AsciiTable.vue           # ASCII 对照表
│   ├── ExportDialog.vue         # 导出对话框
│   ├── FileTransferDialog.vue   # 文件下发配置对话框
│   └── WaveformChart.vue        # 波形图
├── stores/           # Pinia stores（7 个）
│   ├── serial.ts               # 串口连接状态 + 驱动管理
│   ├── messages.ts             # 消息/帧管理
│   ├── commands.ts             # 快速命令
│   ├── settings.ts             # 应用设置
│   ├── recorder.ts             # 字节流录制
│   ├── transfer.ts             # 文件下发引擎
│   └── waveform.ts             # 波形数据
├── serial/           # 串口驱动
│   ├── index.ts                # 驱动工厂（自动选择 + DEV 切换）
│   ├── WebSerialDriver.ts      # Web Serial API 驱动
│   └── SerialPortDriver.ts     # Electron IPC 驱动
├── main/             # Electron 主进程
│   ├── index.ts                # BrowserWindow + IPC handlers
│   └── SerialPortManager.ts    # serialport 库封装
├── preload/          # Electron 预加载
│   └── index.ts                # contextBridge（serial/recorder/platform）
├── mock/             # Mock 驱动 + 场景生成器
├── composables/      # Vue composables（7 个）
│   ├── useFrameSplitter.ts     # 帧分割（间隔/分隔符/定长）
│   ├── useSendHistory.ts       # 发送历史
│   ├── useStorage.ts           # localStorage 抽象
│   ├── useMessageSearch.ts     # 消息搜索编排
│   ├── useTheme.ts             # 主题管理
│   ├── useFileWriter.ts        # 文件写入
│   └── useRecordDirectory.ts   # 录制目录管理
├── utils/            # 纯工具函数（12 个，均有单测覆盖）
│   ├── hex.ts                  # HEX 编解码 + 字节搜索
│   ├── encoding.ts             # UTF-8/ASCII/GBK 编解码
│   ├── checksum.ts             # CRC16/SUM8/XOR8/CRC32
│   ├── byte-parser.ts          # HEX 输入容错解析
│   ├── search.ts               # 消息搜索匹配逻辑
│   ├── message-format.ts       # 消息格式化（Δ/elapsed/时间戳）
│   ├── ascii-table.ts          # ASCII 对照表数据
│   ├── baud.ts                 # 波特率预设/校验/标注
│   ├── download.ts             # 浏览器 Blob 下载
│   ├── export-csv.ts           # CSV 导出
│   ├── export-json.ts          # JSON 导出
│   └── export-waveform-csv.ts  # 波形 CSV 导出
├── themes/           # 主题系统
│   ├── types.ts                # 主题类型定义
│   ├── registry.ts             # 注册表
│   ├── index.ts                # 主题入口
│   └── builtin/                # 内置主题（3 套）
├── locales/          # i18n 文案
│   ├── zh-CN.ts
│   └── en-US.ts
├── styles/
│   ├── tokens.css              # CSS 自定义属性（主题令牌）
│   └── base.css                # 基础重置
├── types.ts          # 全局共享类型（Message/PortOptions/SerialDriver 等）
├── App.vue           # 根布局
└── main.ts           # 入口
```

## 架构说明

所有串口数据以 `Uint8Array` 存储一次，ASCII/HEX 视图按需计算。高频数据通过 `requestAnimationFrame` 批处理摄入，避免压垮 Vue 响应式系统。

`SerialDriver` 接口是核心抽象 —— Pinia stores 依赖此接口而非具体实现，切换驱动时 store 无需改动。驱动选择由工厂 `src/serial/index.ts` 按环境自动判断：Electron → serialport、DEV → localStorage 偏好、浏览器有 Web Serial → webserial、兜底 → mock。

## 生产环境缺失功能

详见 [docs/production-gaps.md](docs/production-gaps.md) 和 [CLAUDE.md](CLAUDE.md) 中的待完成事项。
