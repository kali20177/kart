# 串口调试助手 · serial-demo

面向嵌入式开发调试的现代化串口助手。**聊天气泡式**数据收发、**ASCII / HEX** 双视图、**自定义快速命令**、内置 **ASCII 对照表**。

> 当前为 **阶段 1：前端 UI（纯 Vite + Vue 3，模拟数据驱动）**。
> 串口真实通信（Electron + Web Serial API）在阶段 2 接入，详见文末「阶段 2 落地路径」。

---

## 技术栈

| 维度 | 选型 |
| --- | --- |
| 构建 | Vite 5 + Vue 3 + TypeScript |
| 状态 | Pinia |
| UI 库 | Naive UI |
| 虚拟滚动 | vue-virtual-scroller |
| 持久化 | localStorage（阶段 2 切 electron-store，接口不变） |
| 测试 | Vitest |

## 快速开始（已配置国内镜像）

根目录已含 [.npmrc](./.npmrc)，`npm install` 自动走淘宝 npmmirror，无需手动配置。

```bash
npm install      # 安装依赖（走镜像）
npm run dev      # 启动开发服务器 http://localhost:5273
npm run build    # 类型检查 + 生产构建
npm test         # 运行单元测试
```

> `.npmrc` 中的 `electron_mirror` / `electron_builder_binaries_mirror` 在阶段 1 暂不生效（npm 会提示 Unknown config，可忽略），它们是为阶段 2 安装 Electron 二进制预置的。

## 模拟数据（阶段 1 调试用）

顶部「模拟场景」下拉可切换：

| 场景 | 说明 |
| --- | --- |
| 静默 | 连接但无自动数据 |
| AT 应答 | 每次发送后延时回包（`AT`→`OK`、`AT+CSQ`→信号值等） |
| 二进制连续帧 | 周期吐出 `AA 55 …` 帧，验证 HEX 视图与帧切分 |
| 高吞吐压测 | 高频灌数据，验证虚拟滚动与 rAF 节流 |
| 混合 ASCII | 周期日志 + 偶发 GBK 中文 |

设置抽屉底部还有「注入」按钮，可手动发一段自定义数据。

## 功能一览

- **气泡收发**：RX 左 / TX 左右分色，时间戳精确到毫秒、字节数、模式徽标，悬停可复制 / 复制为 HEX / 重发。
- **ASCII ↔ HEX 切换**：原始字节只存一份，切视图即时重排，不丢数据；HEX 视图为 16 字节/行 + ASCII 透视列。
- **帧切分**：空闲超时 / 分隔符 / 定长 三种策略（设置抽屉切换）。
- **发送框**：行尾符、循环发送（周期 + 次数）、`Enter` 发送、`Ctrl+↑/↓` 翻历史；HEX 输入容错解析（`AA 55`、`0xAA,0x55`、`aa55` 皆可）。
- **快速命令**：增删改、拖拽排序、JSON 导入导出、点击直发、调到发送框；内置 AT 示例。
- **ASCII 对照表**：右侧抽屉，点击行插入到发送框。
- **设置**：编码（UTF-8 / ASCII / GBK）、帧策略、缓冲上限、默认视图、主题（亮/暗/跟随系统）、字号。
- **状态栏**：连接态、端口参数概要、RX/TX 字节统计、信号线状态。

## 目录结构

```
src/
├── components/   # 8 大 UI 组件（气泡 / 列表 / 发送框 / 命令面板 / ASCII 表 / 设置 / 状态栏 / 连接栏）
├── stores/       # Pinia：serial / messages / commands / settings
├── mock/         # MockSerialSource（与未来 Web Serial 同接口）+ scenarios
├── composables/  # useFrameSplitter / useSendHistory / useStorage
├── utils/        # hex / encoding / ascii-table（含单测）
└── types.ts      # 共享类型
```

## 阶段 2 落地路径（Electron + Web Serial）

阶段 1 已为切换预留接缝，落地时**渲染层代码基本不动**：

1. 安装 `electron` / `electron-vite` / `electron-builder`（`.npmrc` 镜像已就绪）。
2. 新增 `src/main/`（窗口 + 串口权限钩子 `select-serial-port`）、`src/preload/`（contextBridge 暴露 store / 文件 API），参考已跑通的 `electron-demo` 的 IPC 契约与安全模型。
3. 写一个实现 `SerialDriver` 接口（见 [src/mock/MockSerialSource.ts](src/mock/MockSerialSource.ts)）的 `WebSerialDriver`，在 [src/stores/serial.ts](src/stores/serial.ts) 中替换 `MockSerialSource` 即可。
4. 把 [src/composables/useStorage.ts](src/composables/useStorage.ts) 内部从 localStorage 切到 electron-store。
5. 日志导出从浏览器 `Blob` 切到 Electron `dialog` + `fs`。

完整方案见 [PLAN-stage1.md](./PLAN-stage1.md)。
