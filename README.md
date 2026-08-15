# KART · 串口调试助手

面向嵌入式开发调试的现代化串口助手。聊天气泡式数据收发、多会话并排对比、帧解码与仪表盘、ASCII / HEX 双视图、帧分割与校验、文件下发、终端模式、TCP 直连、波形可视化，支持浏览器（Web Serial API）和 Electron 桌面应用（serialport 原生库）两种形态。

---

## 功能特性

### 连接

- **三种传输后端**：串口（Web Serial / serialport）、TCP 客户端（Electron）、本地终端（开发验证），连接栏一键切换
- **多会话并排**：可停靠面板布局，同时连接多个设备同屏对比数据流；每会话独立端口参数与解码配置，占用端口自动提示
- **端口占用提示**：被本应用其他会话或外部程序（minicom、其他串口助手）占用的端口，在下拉中禁用并红色标记
- **端口元信息**：厂商 · VID · PID 富信息展示，自定义波特率（可加注释、越界校验）
- **信号控制**：DTR / RTS 电平切换、Break 脉冲（250ms，TX 拉低），用于 bootloader / 复位 / ISP
- **自动重连**：物理掉线后按 2s 间隔自动重连，重连前刷新端口确认设备归位，状态栏倒计时提示
- **参数栏收起**：连接栏可向上收起，把显示空间让给数据区

### 收发与查看

- **聊天气泡收发**：RX 左 / TX 右分色，毫秒时间戳、字节数、帧间 Δt、校验失败标记；悬停可复制 / 复制为 HEX / 重发 / 添加标注 / 插入分隔线
- **ASCII ↔ HEX 双视图**：原始字节只存一份，切视图即时重排不丢数据；HEX 16 字节/行 + ASCII 透视列；超长帧自动折叠（展开/收起）
- **搜索**：文本 / HEX 双模式、命中高亮、上一项 / 下一项导航、当日时间范围筛选
- **帧分割**：空闲超时 / 分隔符 / 定长三种策略
- **校验和**：发送自动追加（CRC16-Modbus / SUM8 / XOR8 / CRC32），接收可选独立校验（支持收发不对称协议）

### 协议解析与可视化

- **帧解码器**：内置字段布局解析器与 Modbus RTU 解码器，帧上叠加结构化字段块（概要行 + 逐字段十六进制/数值）；解码配置会话级按端口持久化，扩展点可注册新解码器
- **仪表盘**：由解码器字段驱动，数字表（大数字 + 阈值着色告警）、状态灯、字段总览表三种 widget 卡片网格，拖拽排序、按端口持久化；Modbus 寄存器轮询监控一屏看当前值
- **波形图**：uPlot 实时 Canvas 时序图，多通道自动检测（无标签 / `label:value` 两种文本行格式），游标读值、双游标 Δ、V/div & ms/div 时基、触发线、暂停回看、CSV 导出
- **终端模式**：xterm 终端视图（VS Code 同款引擎），本地行编辑 / 按键直通两种传输模式，支持 ANSI 色彩、vim/nano 全屏编辑（配合本地终端验证）

### 工程能力

- **文件下发**：分包切片、三种协议封装（raw / len-prefix / seq-crc）、限速（字节速率 + 包间延时）、ACK 流控、断点续传、循环下发、错误注入；消息流内文件气泡实时进度 / 速率 / ETA
- **快速命令**：增删改、拖拽排序、JSON 导入导出、点击直发；每条命令可独立配置校验和
- **录制**：原始字节流实时落盘（txt / csv），目录与格式可配，页面关闭自动落盘
- **标注与导出**：帧标注、分隔线；消息列表导出 TXT / CSV / JSON / Binary 四种格式（含筛选、hex+ascii 双列等选项），波形 CSV、快速命令 JSON 导入导出
- **发送框**：行尾符、循环发送（周期 + 次数）、HEX 输入容错解析（`AA 55`、`0xAA,0x55`、`aa55` 皆可）、发送历史（Ctrl+↑/↓）
- **统计与状态栏**：RX/TX/帧/ERR 统计、帧速率、字节速率、会话时长、缓冲使用率告警、CTS 只读指示、活跃文件下发条

### 体验

- **主题**：3 套内置主题（glass-industrial-dark / glass-industrial-light / oled-hud），亮 / 暗切换
- **i18n**：简体中文 / English
- **帮助**：内置常见问题知识库、快捷键面板、应用日志导出（报障自带版本 / 平台 / 驱动环境信息）
- **ASCII 对照表**：右侧抽屉，点击行插入到发送框

## 运行方式

### 浏览器（Web Serial）

需要 Chromium 内核浏览器（89+），且页面必须处于安全上下文（HTTPS 或 localhost）。

```bash
npm install        # 安装依赖（走国内镜像，无需手动配置）
npm run dev        # 启动开发服务器 http://localhost:5273
```

### Electron 桌面应用

```bash
npm install
npm run electron:dev      # 开发模式（HMR + 主进程/预加载自动重启）
npm run electron:build    # 打包安装包（输出 release/，Windows/macOS/Linux）
npm run electron:preview  # 构建后用 Electron 直接运行（不打包）
```

> Electron 环境自动使用 serialport 原生库，返回真实 COM 口名（如 `COM5`、`/dev/cu.usbserial-1420`）。首次安装若 Electron 二进制下载失败，参考 [CLAUDE.md](./CLAUDE.md) 中的修复步骤。

### 快速上手

1. 选择端口与波特率（或切换 TCP 传输手动填写 `host:port`），点击「连接」
2. 设备数据以气泡形式显示在消息流；右上角可切换 ASCII / HEX 视图、暂停滚动
3. 需要解协议时：连接栏打开「帧解码」选择解码器（如 Modbus RTU），帧上即出现字段块；仪表盘可把字段绑定为数字表 / 状态灯
4. 需要多设备对比时：点击 dock 右上角「＋」新建会话，拖动标签页即可并排

## 技术栈

| 维度 | 选型 |
| --- | --- |
| 构建 | Vite 5 + Vue 3 + TypeScript（strict） |
| 状态 | Pinia（每会话独立 store 实例） |
| UI 库 | Naive UI |
| 布局 | dockview-core（可停靠面板，多会话并排） |
| 终端 | xterm.js（`@xterm/xterm` + addon-fit）+ node-pty（本地终端） |
| 国际化 | vue-i18n（预编译，CSP 友好） |
| 波形图 | uPlot |
| 虚拟滚动 | vue-virtual-scroller |
| 桌面打包 | Electron 31 + vite-plugin-electron + electron-builder |
| 串口（浏览器） | Web Serial API |
| 串口（Electron） | serialport npm 库（主进程 IPC） |
| TCP（Electron） | Node `net` 模块（主进程 IPC） |
| 持久化 | localStorage + IndexedDB 镜像（Electron 下主进程 JSON 文件） |
| 测试 | Vitest + jsdom + Playwright CDP（终端/布局端到端验证） |
