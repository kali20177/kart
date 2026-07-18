# 生产环境缺失功能与已知问题

本文件记录串口调试助手作为**生产环境工具**尚缺的功能（按优先级分层），以及开发中发现的已知技术问题。供后续任务规划与排期参考。

> 最近更新：2026-07-16。已完成项标注 ✅。

## 一、生产环境缺失功能

### 核心调试能力（高优先级，不补日常用会很难受）

1. ✅ **帧间时间差 Δt** — 已完成：`MessageBubble` meta 行在绝对时间后追加 `Δ`（距上一帧间隔）和 `+elapsed`（距会话首帧累计）。计算基于全量时间线（`computeDeltas` on shallowRef），不受方向/搜索过滤影响。格式复用 `formatDelta`/`formatElapsed`，与导出保持一致。
2. ✅ **搜索只能过滤、不能高亮，且搜不了 HEX** — 已完成：文本/HEX 双模式搜索（HEX 复用 `parseHexInput`，宽容分隔）、命中高亮（原生配对：text+ascii / hex+hex；交叉配对仅过滤+导航+flash，避免字节/字符偏移错位）、上一项/下一项导航（`当前/总数` + 自动滚动 + 活动色 + flash）、当日时间范围筛选（`HH:MM:SS[.mmm]`，非法红框）。**不做正则**（嵌入式调试用处不大）。匹配逻辑抽到 `src/utils/search.ts` + `hex.ts#findByteRanges`，响应式编排抽到 `src/composables/useMessageSearch.ts`，均有单测。已知限制：交叉配对无内联高亮、时间筛选不支持跨午夜区间。
3. **发送无 CRC/校验和，接收无校验** — `serial.send` 只拼行尾，无法为载荷自动计算校验和。嵌入式二进制协议几乎都带完整性校验，缺失此项意味着：
   - **发送侧**：需手动用外部工具预计算 CRC/校验和再粘贴 HEX，每次载荷变化都要重新算。典型场景：Modbus RTU 帧尾 CRC16-Modbus、串口舵机/云台协议 SUM8、自定义传感器协议 XOR8、基站/DTU 协议 CRC32。快速命令和循环发送功能都受此限制——载荷静态，无法动态生成合法帧。
   - **接收侧**：`Message.error` 目前仅标记发送失败，未标记校验不匹配。接收侧理应能对匹配到的帧做可选校验（按配置的校验算法验证末 1-4 字节），校验失败的帧在气泡上标记 error badge 并计入错误帧统计。阶段 2 接入真实串口后，还应检测 parity error / frame error / buffer overrun 等物理层异常。
4. ✅ **文件发送（二进制整包下发）** - 已完成 UI 交互与引擎（基于 Mock 驱动）。详细设计见 [docs/file-transfer-design.md](./file-transfer-design.md)。落地内容：
   - **引擎层**（`src/stores/transfer.ts`）：async pump 调度循环 + 状态机（queued/sending/paused/completed/aborted/error）、分包切片、三种协议封装（raw / len-prefix / seq-crc，CRC16-Modbus 内联）、限速（包间延时 + 字节速率令牌桶，取更严者）、ACK 流控（any/byte/echo-crc 三策略 + 超时/NACK 重试）、循环下发（`repeat`）、断点续传（`startOffset` + seq 对齐）、错误注入（破坏 CRC / 跳过 ACK）、断线自动中止。
   - **UX 层**：`FileTransferDialog`（预设：原始整包/STM32-ISP/ESP32/压测/自定义 + 文件拖拽与移除）、`FileTransferBubble`（消息流内单条文件气泡：进度条/速率/ETA/暂停继续中止重试详情，按 `Message.kind==='file'` 委托渲染）、`InputComposer` 📎 按钮 + 拖拽入口、`StatusBar` 活跃下发紧凑条。
   - **限速语义可视化**：字节速率输入框实时显示当前波特率对应的物理层上限（按 `dataBits/parity/stopBits` 推算 bit/字节），超限橙色警告。明确「有效速度 = min(波特率 B/s, 字节速率)」，二者作用层不同（物理硬天花板 vs 应用软节流保护设备缓冲）。
   - **Mock 阶段局限**：`MockSerialSource.write()` 立即返回不按波特率节流，当前传输速率纯属 `sleep()` 软节流，波特率暂无真实约束。阶段 2 接入 Web Serial 后波特率才成为真实物理天花板，届时 UI 提示即准确生效（前端已按未来行为设计，后端切换零改动）。
   - **待补**：① 纯逻辑工具（crc/chunk-framer/rate-limit）当前内联在 transfer.ts，设计稿规划的独立 `utils/*.ts` + 单测尚未拆分；② ACK `echo-crc` 策略暂简化为「收到任意字节即 ACK」，未做 CRC 回吐比对；③ 真实 Web Serial 驱动接入（阶段 2）；④ 大文件流式读（v1 用 `File.arrayBuffer()`，数百 MB 内 OK）。
5. **DTR/RTS/Break 控制** — `SerialDriver` 只有 `getSignals`（只读），无 `setSignals`。ESP32/STM32 bootloader、复位、ISP 靠 DTR/RTS 组合 + Break。前端无按钮，接口契约无。〔依赖 Web Serial 驱动〕
6. ✅ **暂停时数据直接丢弃** — 暂停时数据仍不缓冲保留（波形追加缓冲无意义：恢复瞬间刷新长段 + 超缓冲区截断后数据不全），恢复时通过 warning toast 提示用户缺失数据的时间段（`HH:MM:SS.mmm – HH:MM:SS.mmm (Xs)`），消息列表与波形图均有各自独立提示。
7. ✅ **布局与发送历史不持久化** — 已完成：右栏宽度（`App.vue` rightWidth）、输入框高度（`InputComposer` DOM 拖拽高度）、发送历史（`useSendHistory`）三项均通过 `useStorage` 持久化到 localStorage。发送历史限制最近 50 条，避免 localStorage 撑爆。
8. ✅ **自定义波特率** — 已完成（filterable+tag 输入、自定义档位+标注、预设标注、校验、持久化）。

### 专业工具进阶预期（中优先级）

9. ✅ **统计面板太薄** — 已完成：`StatusBar` 新增帧数（RX/TX）、帧速率（f/s）、字节速率（B/s）、会话时长（HH:MM:SS）、缓冲使用率（百分比+>80% 告警色）。速率每 1s 采样计算。断开后统计灰度冻结保留，重新连接恢复活跃。
10. ✅ **标记/注释/分隔** — 已完成：支持两种操作——① 右键帧气泡「添加标注」可在该帧上附带 📌 注释文本，导出时该行携带 Note 字段；② 右键帧气泡「在此前插入分隔线」可在消息流任意位置插入视觉分隔线（可选标签），导出时列为单独分隔行。上下文菜单含「多选」入口。四种导出格式（TXT/CSV/JSON/Binary）均已适配，导出对话框新增「包含分隔线」「包含标注」选项（默认不勾选）。
11. ✅ **会话录制与回放** — 无此需求，不实现。
12. ✅ **导出格式单一** — 已完成：支持 TXT/CSV/JSON/Binary 四种导出格式，含筛选导出、hex+ascii 双列等选项。
13. **结构化协议解析器** — 帧切分解决了切帧，无"帧内字段（header/len/cmd/payload/crc）可配置渲染"。无 Modbus 等通用协议解码。
14. **单连接，不支持多端口并发** — `serial` store 单例 driver。同时盯多设备做不到。〔依赖驱动〕
15. **快速命令不支持变量/宏替换** — `QuickCommand.payload` 静态。缺计数器、时间戳、CRC 占位；无每命令独立循环发送。
16. ✅ **波形缺测量与导出** — 已完成：`WaveformChart` 支持游标读值、双游标 Δ、V/div & ms/div 时基、触发线、每通道自定义颜色、暂停回看，支持 CSV 导出波形数据。
17. **自动重连是空开关** — `autoReconnect` 设置存在，无重连逻辑，无掉线提示。〔依赖驱动〕
18. ✅ **缺少实时日志落盘** — 已完成。原始字节流在帧切分之前通过 `serial.onData`/`onTxData` 双通道捕获，经 500ms/64KB 缓冲批量写入文件。平台抽象 `IFileWriter`（`src/composables/useFileWriter.ts`）：浏览器走 File System Access API（`showSaveFilePicker` + `FileSystemWritableFileStream`），Electron 走 `dialog.showSaveDialog` + `fs.createWriteStream` IPC。录制器 store（`src/stores/recorder.ts`）管理状态机（idle→recording→stopping→idle/error），支持断线自动停止、写入异常进入 error 状态。录制按钮+格式切换在 `ConnectionBar`，录制指示（脉动红点+文件名+文件大小+已录制时长）在 `StatusBar`，菜单项在 `MenuBar`。输出格式可选 `.txt`（带时间戳 HEX 行，含方向标记 RX/TX）或 `.csv`（timestamp,direction,hex,ascii 四列）。浏览器不支持 File System Access API 时按钮自动置灰。
   - **老化/稳定性测试**：设备连续运行 24h+，需要完整记录所有串口输出用于事后异常回溯。内存缓冲远远不够，必须流式写入磁盘。
   - **现场抓日志**：客户现场复现问题，可能需要抓取数小时数据带回实验室分析。
   - **二进制原始数据**：波形解析、协议分析等场景需要保留原始字节流（不经帧切分），以便后续用不同帧切分配置或不同采样率重新解析同一份数据。
   建议在 `ConnectionBar` 或菜单增加「录制」按钮，点击后通过 File System Access API（浏览器）或 Electron `dialog.showSaveDialog` 选择输出文件路径，原始字节流实时追加写入。StatusBar 显示录制状态（红点+文件大小+已录制时长）。导出格式可选 .bin（原始字节）或 .txt（带时间戳）。录制的文件后续可通过「导入」功能回放分析。

### 打磨项（低优先级）

19. **清空无确认/无撤销** — `messages.clear` 直接清空，误点丢失。
20. **缓冲满无感知** — 超 `bufferLimit` 静默裁剪，无"已丢弃 N 帧"提示。
21. ✅ **全局快捷键缺失** — 已有快捷键（`Ctrl/Cmd+Enter` 发送、`Alt/Ctrl+↑↓` 翻历史）已在帮助菜单新增「快捷键」面板展示，不额外添加显式 UI 已有操作的快捷键。
22. **关键字告警** — 收到特定模式无声音/通知。
23. **端口元信息缺失** — `listPorts` 只字符串数组，无 VID/PID/厂商/占用提示。〔依赖驱动〕
24. **复制能力弱** — 单帧复制带时间戳/方向 ✅；多选批量复制 / 导出 txt / 删除 ✅（全选即"复制全部可见"）；仍缺 CSV 行。
25. **`useStorage` 同步无容量保护** — 全同步 localStorage，阶段 2 换 electron-store（async）接口签名要改。

### 边界说明

- 第 5、14、17、23 项依赖 Web Serial 驱动实现相应能力，前端 UI 可先做但落地需驱动支持（属"阶段 2 路线图"）。
- 其余各项（1–4、6–13、15–16、18–22、24–25）纯前端可独立完成。

---

## 二、已知技术问题

### ✅ `vite.config` 的 `test.environment`「未生效」（已排查并修复）

- **原误判**：曾以为 `environment: 'jsdom'` 没生效、测试跑在 node 环境。
- **实况**：jsdom 一直生效（`navigator.userAgent` 为 `jsdom/24.x`，`window`/`document` 均可用）。真正症状只是 `localStorage` 不可用，并抛 `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`。
- **真正根因**：Node 22+ 在 `globalThis` 上装了实验性 `localStorage` 访问器（`--experimental-webstorage`），它是 own property，遮蔽了 jsdom 的 Web Storage。vitest 1.6.1 的 jsdom 环境只把 jsdom window 的「自有可枚举属性」拷到全局，而 jsdom 的 `localStorage` 位于原型链上不会被拷贝，于是全局 `localStorage` 命中 Node 的实验性访问器（getter 返回 undefined + 警告）。**与 `defineConfig` 从 `'vite'` 还是 `'vitest/config'` 导入无关**——二者运行时都原样透传 `test` 字段，仅影响类型标注。
- **修复**：新增 `src/test/setup.ts`，在 `beforeEach` 用 `vi.stubGlobal` 提供内存版 `localStorage`（每用例重置保证隔离），并在 `vite.config.ts` 的 `test.setupFiles` 注册。`serial.spec.ts` 内冗余的 stub 及误判注释已移除。
- **备选（未采用）**：`NODE_OPTIONS=--no-experimental-webstorage` 可让 jsdom 的 localStorage 接管，但该标志仅 Node 22+ 存在，在 Node 20 上会报 `bad option`，跨版本不可移植，故未采用。
- **影响**：不影响生产。现已消除警告，后续 DOM/组件渲染测试（`@vue/test-utils` 挂载）可直接用 jsdom。
