# 生产环境缺失功能与已知问题

本文件记录串口调试助手作为**生产环境工具**尚缺的功能（按优先级分层），以及开发中发现的已知技术问题。供后续任务规划与排期参考。

> 最近更新：2026-08-18。已完成项标注 ✅，已决定不实现项标注 ~~删除线~~。

## 一、生产环境缺失功能

### 核心调试能力（高优先级，不补日常用会很难受）

1. ✅ **帧间时间差 Δt** — 已完成：`MessageBubble` meta 行在绝对时间后追加 `Δ`（距上一帧间隔）和 `+elapsed`（距会话首帧累计）。计算基于全量时间线（`computeDeltas` on shallowRef），不受方向/搜索过滤影响。格式复用 `formatDelta`/`formatElapsed`，与导出保持一致。
2. ✅ **搜索只能过滤、不能高亮，且搜不了 HEX** — 已完成：文本/HEX 双模式搜索（HEX 复用 `parseHexInput`，宽容分隔）、命中高亮（原生配对：text+ascii / hex+hex；交叉配对仅过滤+导航+flash，避免字节/字符偏移错位）、上一项/下一项导航（`当前/总数` + 自动滚动 + 活动色 + flash）、当日时间范围筛选（`HH:MM:SS[.mmm]`，非法红框）。**不做正则**（嵌入式调试用处不大）。匹配逻辑抽到 `src/utils/search.ts` + `hex.ts#findByteRanges`，响应式编排抽到 `src/composables/useMessageSearch.ts`，均有单测。已知限制：交叉配对无内联高亮、时间筛选不支持跨午夜区间。
3. ✅ **发送自动计算校验和 + 接收可选校验** — 已完成：
   - **发送侧**：`serial.send` 在拼行尾前自动追加指定校验和（CRC16-Modbus/SUM8/XOR8/CRC32），覆盖 Modbus RTU、舵机/云台、传感器、基站/DTU 常见嵌入式协议。快速命令可独立配置校验和（inherit 全局或覆盖），循环发送/文件发送均受益（文件引擎 CRC16 已复用 `checksum.ts`）。
   - **接收侧**：新增 `rxChecksumAlgorithm` 独立设置（不再耦合 sendChecksum），支持收发不对称协议。校验前自动剥离帧尾分隔符，避免 `\r\n` 被当作载荷导致必败。校验失败帧气泡标记 `✗ {t('bubble.checksumFailed')}`，StatusBar 增加 ERR 帧错误计数。
   - **2026-08-15 更新**：发送/接收校验从全局设置移出，改为会话级 `session.checksum`（`ChecksumConfig`）按端口持久化——多会话可各配各的校验方式，ConnectionBar 弹窗编辑（`ChecksumSettingsModal`）；快速命令的「inherit」语义随之变为继承会话默认（不再有全局默认）。未配置端口默认不启用校验。
   - **架构**：四种算法集中维护在 `src/utils/checksum.ts`，所有调用方都引用同一实现，消除原 `transfer.ts` 内联 CRC16 重复。
4. ✅ **文件发送（二进制整包下发）** - 已完成 UI 交互与引擎（基于 Mock 驱动）。详细设计见 [docs/file-transfer-design.md](./file-transfer-design.md)。落地内容：
   - **引擎层**（`src/stores/transfer.ts`）：async pump 调度循环 + 状态机（queued/sending/paused/completed/aborted/error）、分包切片、三种协议封装（raw / len-prefix / seq-crc，CRC16-Modbus 内联）、限速（包间延时 + 字节速率令牌桶，取更严者）、ACK 流控（any/byte/echo-crc 三策略 + 超时/NACK 重试）、循环下发（`repeat`）、断点续传（`startOffset` + seq 对齐）、错误注入（破坏 CRC / 跳过 ACK）、断线自动中止。
   - **UX 层**：`FileTransferDialog`（预设：原始整包/STM32-ISP/ESP32/压测/自定义 + 文件拖拽与移除）、`FileTransferBubble`（消息流内单条文件气泡：进度条/速率/ETA/暂停继续中止重试详情，按 `Message.kind==='file'` 委托渲染）、`InputComposer` 📎 按钮 + 拖拽入口、`StatusBar` 活跃下发紧凑条。
   - **限速语义可视化**：字节速率输入框实时显示当前波特率对应的物理层上限（按 `dataBits/parity/stopBits` 推算 bit/字节），超限橙色警告。明确「有效速度 = min(波特率 B/s, 字节速率)」，二者作用层不同（物理硬天花板 vs 应用软节流保护设备缓冲）。
   - **Mock 阶段局限**：`MockSerialSource.write()` 立即返回不按波特率节流，当前传输速率纯属 `sleep()` 软节流，波特率暂无真实约束。阶段 2 接入 Web Serial 后波特率才成为真实物理天花板，届时 UI 提示即准确生效（前端已按未来行为设计，后端切换零改动）。
   - **2026-08-18 更新（三项待补全部完成）**：
     - ① ✅ 纯逻辑工具拆分——`src/utils/chunk-framer.ts`（切片/三种协议封装/错误注入）、`rate-limit.ts`（字节速率+包间延时双旋钮）、`ack.ts`（any/byte/echo-crc 判定，含小端 CRC 比对），各有单测（共 22 例）；`transfer.ts` 仅剩调度与 ACK 订阅。
     - ② ✅ echo-crc 真实现——expected CRC（payload 的 CRC16）经 pump→sendWithRetry→waitForAck 管线传入；回吐字节累积 ≥2 字节后按小端与期望比对；NACK(0x15) 经宽限窗口判定（echo-crc 首字节 0x15 后等第二字节 ≤ min(ackTimeout/2, 50ms)——到达则按 CRC 比对、不到则判 NACK，消除「CRC 字节恰为 0x15 → 每次重试确定性误判」的线缆歧义）；超时与响应竞态由幂等 finish 守卫，订阅期同步回调防泄漏。store 级假设备行为测试（`transfer.spec.ts`，12 例）覆盖：正确回吐完成 / CRC 不匹配重发本包 / NACK 立即重试 / 超时重试耗尽报错 / 错误注入→回吐比对失败→重试闭环 / CRC 恰含 0x15（低字节、高字节两条）不再误判 / byte 模式回归 / sendRaw 抛错引擎不卡死可再下发。
     - ③ ✅ 真实 Web Serial 驱动接入（同前，`WebSerialDriver`，Chromium 89+，HTTPS + 用户授权）。
     - ④ ✅ 流式读——`start()` 不再整文件 `File.arrayBuffer()`，改 `ChunkSource` 抽象（`src/utils/chunk-source.ts`：fileSource 逐块 `file.slice()` 随机切片读，jsdom 无 arrayBuffer 时回退 FileReader）；内存占用从 O(整文件) → O(chunkSize)。retry/repeat/startOffset 的随机重读语义不变。验证：双路径字节恒等（fileSource 逐块读 vs 内存切片参考逐字节一致）+ 读取有界性（单次读取 ≤ chunkSize、读取次数 = 分块数、从未整文件一次读）。顺带修复：retry 原先因 cleanup 清空 fileBytes 而「完成后不可重试」实为失效，现持 File 句柄，完成后重试可用。**已知限制**：进度字段按 50ms 批处理刷新，超快传输（无 ACK 无延时）完成时气泡进度可能停在 0（实际字节以发出 wire 为准）。**异常兜底**：sendRaw 抛错（驱动 IO 故障）按 retries 重试；pump 外层 try/catch 兜底读片/订阅等未捕获异常收敛为 error 并释放引擎（此前未捕获拒绝会永久卡死 pumpRunning，后续下发被静默拒绝）。
5. ✅ **DTR/RTS/Break 控制** — 已完成。`SerialDriver` 新增 `setSignals({ dtr?, rts? })` 与 `setBreak(active)`，四种驱动实现：Web Serial 走 `port.setSignals({ dataTerminalReady, requestToSend, break })`（`env.d.ts` 补充输出线字段）；Electron 走 IPC → 主进程 serialport `port.set({ dtr/rts/brk })`；mock 记录状态供测试断言；unsupported 抛错。serial store 新增 `dtr`/`rts` 状态与 `setDtr`/`setRts`/`pulseBreak`（250ms 脉冲，`breakBusy` 防连点），连接后自动重放上次电平（断线重连不丢意图）。UI 在 StatusBar 信号区放置 DTR/RTS 切换 chips + BRK 脉冲按钮，并保留 CTS 只读指示（状态圆点样式、非按钮，hover 注明「只读」；DCD/DSR/RI 指示已移除），断开时禁用+灰度。Web Serial 与 serialport 均原生支持，不再属「待驱动」项。
6. ✅ **暂停时数据直接丢弃** — 暂停时数据仍不缓冲保留（波形追加缓冲无意义：恢复瞬间刷新长段 + 超缓冲区截断后数据不全），恢复时通过 warning toast 提示用户缺失数据的时间段（`HH:MM:SS.mmm – HH:MM:SS.mmm (Xs)`），消息列表与波形图均有各自独立提示。
7. ✅ **布局与发送历史不持久化** — 已完成：右栏宽度（`App.vue` rightWidth）、输入框高度（`InputComposer` DOM 拖拽高度）、发送历史（`useSendHistory`）三项均通过 `useStorage` 持久化到 localStorage。发送历史限制最近 50 条，避免 localStorage 撑爆。
8. ✅ **自定义波特率** — 已完成（filterable+tag 输入、自定义档位+标注、预设标注、校验、持久化）。

### 专业工具进阶预期（中优先级）

9. ✅ **统计面板太薄** — 已完成：`StatusBar` 新增帧数（RX/TX）、帧速率（f/s）、字节速率（B/s）、会话时长（HH:MM:SS）、缓冲使用率（百分比+>80% 告警色）。速率每 1s 采样计算。断开后统计灰度冻结保留，重新连接恢复活跃。
10. ✅ **标记/注释/分隔** — 已完成：支持两种操作——① 右键帧气泡「添加标注」可在该帧上附带 📌 注释文本，导出时该行携带 Note 字段；② 右键帧气泡「在此前插入分隔线」可在消息流任意位置插入视觉分隔线（可选标签），导出时列为单独分隔行。上下文菜单含「多选」入口。四种导出格式（TXT/CSV/JSON/Binary）均已适配，导出对话框新增「包含分隔线」「包含标注」选项（默认不勾选）。
11. ✅ **会话录制与回放** — 无此需求，不实现。
12. ✅ **导出格式单一** — 已完成：支持 TXT/CSV/JSON/Binary 四种导出格式，含筛选导出、hex+ascii 双列等选项。
13. ✅ **结构化协议解析器** — 已完成（帧解码器，commit `220cc5c` 起）。`src/decoders/` 注册表 + 内置解码器：**字段布局解析器**（`field`，u8/u16/u32 等格式、偏移/长度精确校验防越界）+ **Modbus RTU**（`modbus-rtu`，请求/响应按 byteCount 一致性判别、寄存器组多值字段、异常响应解析）。解码成功的帧叠加字段块（概要行 + 逐字段十六进制/数值），不替换原始字节；解码配置会话级按端口持久化（`decoder-config:<port>`，`id=''` 即不启用）。解码器注册表为可扩展点（未来 JS 脚本解码器可复用同一契约，CSP 禁 eval 需 vm/worker 沙箱）。其上构建**仪表盘**（数字表/状态灯/字段总览 widget、阈值告警、拖拽排序，见 [docs/dashboard-design.md](./dashboard-design.md)）。
14. ✅ **单连接，不支持多端口并发** — 已完成（commit `4f792ca`/`31dfb06`/`7503179`）。Electron 主进程 `SerialPortManager` 由单端口实例改为 `Map<path, PortEntry>`，支持并发打开多个端口，同端口二次 open 拒绝并提示占用；IPC 事件 payload 携带端口路径，渲染端按 `_openPath` 过滤分发。UI 层多会话 tab 布局（`SessionPane`）：每 tab 一个 Session（独立驱动 + store 六件套），`v-show` 切换保留隐藏会话存活，可同时盯多设备；根层对话框按 opener 会话绑定，全局组件走 `useActiveSession`。Web Serial 侧 `_entries[]` 亦支持多端口。注意：`portOptions` 不再自动落盘（多会话无法区分意图，仅存会话内存）。
15. ✅ **快速命令不支持变量/宏替换** — 已完成（2026-08-17）：发送时展开占位符 + 每命令独立循环发送。展开逻辑为纯函数 `src/utils/command-vars.ts`（`expandCommandVars`，有单测 15 例）：`{time}`（`HH:MM:SS`）/ `{time:full}`（`YYYY-MM-DD HH:MM:SS`）`/ {seq}`（每命令自增序号，hex 模式单字节 00-FF 取模、ascii 模式十进制）`/ {rand}`（随机字节，hex 模式单字节、ascii 模式十进制 0-255）。展开发生在模式转换前，因此校验和自动覆盖展开后的内容（与既有每命令校验和/会话默认校验天然联动）；未知 `{xxx}` 原样保留，不破坏普通载荷。序号计数器在 commands store（`nextSeq`，按命令 id 独立、删除命令即清理、不持久化重启归零）。UI：快速命令卡片新增 ↻ 按钮启停本命令循环发送（间隔/次数在编辑弹窗配置，次数 0=无限，复用发送框的循环 toast 文案），循环启动时快照目标会话与校验配置（切 tab 不串口、断连自动停、编辑/删除命令先停循环），卡片点击在循环中变为停止（与发送框语义一致）。**不做**：表达式计算 / JS 或 Lua 脚本 / 变量表绑定（Serial Studio Pro 级，KART 不需要）。
16. ✅ **波形缺测量与导出** — 已完成：`WaveformChart` 支持游标读值、双游标 Δ、V/div & ms/div 时基、触发线、每通道自定义颜色、暂停回看，支持 CSV 导出波形数据。
17. ✅ **自动重连是空开关** — 已完成。`settings.autoReconnect` 开关在 `SettingsModal` 连接页生效。串口 store（`src/stores/serial.ts`）在驱动检测到物理掉线（`driver.isOpen` 转 false，非用户主动断开）时，按固定 2s 间隔无限次重试 `connect()`；用户点击断开/切换驱动走 `userDisconnect()` 标记原因不重连，关闭开关立即停止挂起重连。重连前 `refreshPorts()` 确认设备归位，未归位则继续排程；`WebSerialDriver.listPorts` 现重新拉取 `getPorts()`，让拔插后重新接入的已授权端口自愈列表，支持 Web Serial 下的断插重连。状态：`reconnecting`/`reconnectAttempts`/`reconnectNextAt`，`StatusBar` 显示橙色 LED +「重连中…{n}s后重试 · 第{m}次」倒计时（nowTick 驱动 1s 刷新）；重连成功在 `ConnectionBar` 弹一次 toast。判定逻辑集中在纯函数 `src/utils/reconnect.ts`（`shouldReconnect` / `countdownSecs`，有单测 8 例），避免 store 与组件各算一套。
18. ✅ **缺少实时日志落盘** — 已完成。原始字节流在帧切分之前通过 `serial.onData`/`onTxData` 双通道捕获，经 500ms/64KB 缓冲批量写入文件。平台抽象 `IFileWriter`（`src/composables/useFileWriter.ts`）：浏览器走 File System Access API（`showSaveFilePicker` + `FileSystemWritableFileStream`），Electron 走 `dialog.showSaveDialog` + `fs.createWriteStream` IPC。录制器 store（`src/stores/recorder.ts`）管理状态机（idle→recording→stopping→idle/error），支持断线自动停止、写入异常进入 error 状态。录制按钮+格式切换在 `ConnectionBar`，录制指示（脉动红点+文件名+文件大小+已录制时长）在 `StatusBar`，菜单项在 `MenuBar`。输出格式可选 `.txt`（带时间戳 HEX 行，含方向标记 RX/TX）或 `.csv`（timestamp,direction,hex,ascii 四列）。浏览器不支持 File System Access API 时按钮自动置灰。
   - **老化/稳定性测试**：设备连续运行 24h+，需要完整记录所有串口输出用于事后异常回溯。内存缓冲远远不够，必须流式写入磁盘。
   - **现场抓日志**：客户现场复现问题，可能需要抓取数小时数据带回实验室分析。
   - **二进制原始数据**：波形解析、协议分析等场景需要保留原始字节流（不经帧切分），以便后续用不同帧切分配置或不同采样率重新解析同一份数据。
   建议在 `ConnectionBar` 或菜单增加「录制」按钮，点击后通过 File System Access API（浏览器）或 Electron `dialog.showSaveDialog` 选择输出文件路径，原始字节流实时追加写入。StatusBar 显示录制状态（红点+文件大小+已录制时长）。导出格式可选 .bin（原始字节）或 .txt（带时间戳）。录制的文件后续可通过「导入」功能回放分析。

### 打磨项（低优先级）

19. ~~**清空无确认/无撤销**~~ — **已决定不实现**（2026-08 产品决策）：`messages.clear` 直接清空；每次确认反而影响操作体验，保持现状。
20. ✅ **缓冲满无感知** — 已完成：messages store 环形裁剪时累计 `droppedFrames`，波形 history 裁剪累计 `droppedSamples`，均在 `clear()` 重置。MessageList 列表顶部显示可关闭的「已丢弃 N 帧」提示条，WaveformChart 工具栏显示可关闭的「已丢弃 N 采样」标签；关闭后新一轮丢弃（计数 0→正数）重新出现。新增 mock `buffer-flood` 灌满压测场景（高频数值行，配合「分隔符 \n」帧策略数秒触发），供快速验证。
21. ✅ **全局快捷键缺失** — 已有快捷键（`Ctrl/Cmd+Enter` 发送、`Alt/Ctrl+↑↓` 翻历史）已在帮助菜单新增「快捷键」面板展示，不额外添加显式 UI 已有操作的快捷键。
22. ~~**关键字告警**~~ — **已决定不实现**（2026-08 产品决策）：收到特定模式声音/通知告警需求不明确、ROI 低，不做。需要验证数据特征时用「搜索 + 标注」替代。
23. ✅ **端口元信息缺失（VID/PID/厂商）** — 已完成：`SerialDriver.listPorts()` 返回结构化 `PortInfo[]`（path/manufacturer/vendorId/productId），不再只给字符串数组。serialport 驱动透传主进程 `SerialPortInfo` 富数据；Web Serial 用 `getInfo()` 取 VID/PID，并按 `src/utils/usb-vendors.ts` 常见厂商表反查厂商名（查不到显示裸 ID）；mock 提供造假完整元数据供开发预览。UI 采用渐进披露：端口下拉触发框仍只显示路径，菜单项第二行灰色小字显示「厂商 · VID:xxxx PID:xxxx」。**占用提示**也已实现：主进程 `SerialPortManager.probePortBusy` 在枚举时对每个端口尝试独占打开探测（`dtr:false/rts:false` 尽量不扰动电平、成功立即关闭释放、1s 超时兜底），打开失败判定为被其他程序占用，`listPortsAsync` 返回 `busy` 字段透传到下拉——busy 端口禁用 + 红色「被其他程序占用」，与「已被其他会话占用」（会话间提示）区分；`refreshPorts` 自动选中跳过 busy 端口。**已知限制**：busy 为枚举时瞬时快照非实时，需刷新端口重新探测；Web Serial 无此探测能力；probe 仅将锁定类打开失败（lock/busy/in use/access is denied 等）判为占用——权限不足（EACCES）、设备不存在/拔出等非锁定错误不判 busy，端口保持可选，连接时报真实错误。
24. **复制能力弱** — 单帧复制带时间戳/方向 ✅；多选批量复制 / 导出 txt / 删除 ✅（全选即"复制全部可见"）。~~CSV 行复制~~ — **已决定不实现**（2026-08-17 产品决策）：导出对话框已覆盖 CSV 场景，剪贴板复制 CSV 行 ROI 低。
25. ✅ **`useStorage` 同步无容量保护** — 已完成。`useStorage` 同步 API（`{get,set,remove}`）保持不变，新增直写落盘层 `src/utils/persist.ts`（`persistNow`）：用户数据（settings/commands/customBaudRates/autoSave/export-preferences/record-dir-*）变更即同步写 localStorage + 异步镜像（浏览器 → IndexedDB `kart-persist`；Electron → 主进程 `JsonStore` 落盘 `userData/kart-settings.json`，防抖 500ms + 原子写 + will-quit 同步刷盘）。容量监控：落盘时按 `estimateJsonSize` 累计占用，≥1.5MB 触发全量快照导出（浏览器 Blob 下载 / Electron 系统对话框），每会话限一次并 toast 提醒。布局/临时键（rightWidth/inputHeight/sendHistory）仍走同步 localStorage（vueuse `useStorage`），量级小无需镜像。`clear()` 的 `storage.remove` 语义保留（镜像仅作备份不删除）。

### 边界说明

- 本文件记录的全部功能项与技术问题均已完成或已决策不实现（2026-08-18）。细节可在代码与 git 历史中追溯，本文件可归档。

---

## 二、已知技术问题

### ✅ 巨型气泡列表冻结：超大帧 + 自动跟随导致主线程饱和（已修复，含后续开发注意事项）

- **症状**：`buffer-flood` 灌满压测在 **gap-timeout** 帧策略下（每 50ms 的 500 行被合并成一帧 → 巨型气泡），消息列表在缓冲占用约 64% 时彻底卡死——数据不刷新、滚动条拖不动；到缓冲满（列表长度恒定）后恢复。
- **根因**：自动跟随滚动（`watch(messages.length) → scrollToBottom`）在列表增长期每 flush 把新巨型气泡渲染进视口，**持续新建数百行级 DOM 节点 + 布局**；主线程逐帧累积饱和。缓冲满后长度恒定 → 自动跟随 watch 不再触发 → 不再新建巨型 DOM → 恢复。截断上限从无 → 4096 字节，卡死点从 64% → 90%，证实「每气泡 DOM/布局代价」为主因。
- **修复**（`MessageBubble.vue`）：**两档截断**——超过 `TRUNCATE_THRESHOLD`(4096B) 的帧判定为超长帧，折叠时只渲染前 `PREVIEW_BYTES`(512B)（ASCII 按字符切防切坏多字节、HEX 只对前部 hexDump），提供「展开全部/收起」按钮；气泡 DOM 与测量代价有界。高度变化由 DynamicScroller 的 ResizeObserver 自动重测。折叠时不渲染搜索高亮（偏移不再匹配全量）。
- **⚠️ 未来开发注意事项**：
  1. **调大 bufferLimit 不会让上述硬冻结回来**（帧大小已封顶，代价与上限无关）。但**持续收数据时每次刷入仍对全部条目做 O(n) 重算**（DynamicScroller `sizes`/`itemsWithSize` + `filtered` + `computeDeltas`），bufferLimit 调到 5 万～10 万时会从「轻快」变成「渐进卡顿掉帧」——是变慢而非硬冻结，属独立问题。若要支撑超大 bufferLimit，需换虚拟化方案（固定高度的 RecycleScroller）或对条目数封顶。
  2. **gap-timeout 把帧率锁在 ~1/gapMs**（默认 20ms → 约 20 帧/秒），`buffer-flood` 场景只有在**分隔符 \n** 策略下才能秒级灌满缓冲验证丢弃提示；gap-timeout 下填满需数分钟且全是巨型帧。
  3. 巨型帧的展开是单次用户操作，展开渲染全量可接受；但若未来有「导出/复制巨帧」之外的批量全量渲染需求，需再次评估截断策略。

### ✅ `vite.config` 的 `test.environment`「未生效」（已排查并修复）

- **原误判**：曾以为 `environment: 'jsdom'` 没生效、测试跑在 node 环境。
- **实况**：jsdom 一直生效（`navigator.userAgent` 为 `jsdom/24.x`，`window`/`document` 均可用）。真正症状只是 `localStorage` 不可用，并抛 `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`。
- **真正根因**：Node 22+ 在 `globalThis` 上装了实验性 `localStorage` 访问器（`--experimental-webstorage`），它是 own property，遮蔽了 jsdom 的 Web Storage。vitest 1.6.1 的 jsdom 环境只把 jsdom window 的「自有可枚举属性」拷到全局，而 jsdom 的 `localStorage` 位于原型链上不会被拷贝，于是全局 `localStorage` 命中 Node 的实验性访问器（getter 返回 undefined + 警告）。**与 `defineConfig` 从 `'vite'` 还是 `'vitest/config'` 导入无关**——二者运行时都原样透传 `test` 字段，仅影响类型标注。
- **修复**：新增 `src/test/setup.ts`，在 `beforeEach` 用 `vi.stubGlobal` 提供内存版 `localStorage`（每用例重置保证隔离），并在 `vite.config.ts` 的 `test.setupFiles` 注册。`serial.spec.ts` 内冗余的 stub 及误判注释已移除。
- **备选（未采用）**：`NODE_OPTIONS=--no-experimental-webstorage` 可让 jsdom 的 localStorage 接管，但该标志仅 Node 22+ 存在，在 Node 20 上会报 `bad option`，跨版本不可移植，故未采用。
- **影响**：不影响生产。现已消除警告，后续 DOM/组件渲染测试（`@vue/test-utils` 挂载）可直接用 jsdom。

### ~~二进制波形 X 轴时间漂移~~（已移除）

- **处置**：二进制解析模式已移除（参见 commit 历史），波形视图现仅支持文本行解析（Arduino Serial.println 风格）。X 轴统一使用真实到达时间 `Date.now()`，不存在漂移问题。未来若重新引入二进制/结构化字节流协议，届时重新评估时间对齐策略。

### ✅ 会话接线 spec 隐含时序脆弱性（flaky 风险）（已修复）

- **位置**：`src/session/session.spec.ts` 的 `injectLine()` 用固定 `await sleep(50)` 等待 `gapMs(20)` 帧关闭 + rAF 批处理刷入（jsdom 下 rAF 被 polyfill 成 `setTimeout(16)`）。
- **症状**：在 20+ 次连续运行中稳定通过，但本地偶见「1 failed | 3 passed」的一次性失败（未能稳定复现）。CI 机器高负载 / 调度抖动时，固定 50ms 可能不足以覆盖「20ms gap-timeout → flush 尾帧 → rAF 回调」整条链路，导致 `session.messages.messages` / `session.waveform.history` 断言读到的还是上一轮状态。
- **根因**：用墙钟睡眠作为「帧已就绪」的同步信号，未直接观测真实完成事件。
- **影响**：不影响生产，仅测试稳定性。
- **处置**（commit `81180f5`）：`injectLine` 改为轮询消息列表条数达到期望累计值（真实完成事件），带 2s 超时兜底，删除固定 sleep。连续运行 5 次验证稳定。

### ✅ 录制器 `pagehide` 落盘未真正 close writer（已修复）

- **位置**：`src/stores/recorder.ts` `handlePageHide()` 末尾。
- **症状**：页面/窗口关闭时缓冲数据「尽力落盘」的目标未达成——`void flushBuffer().then(() => writer?.close())` 紧跟 `writer = null`，而 `flushBuffer()` 是 async，`.then` 回调执行时闭包里的 `writer` 已被置 null，`writer?.close()` 永不执行，writer 句柄在页面销毁前不会被 close。
- **时序**：`git blame` 确认该行早于会话依赖注入重构（commit `3237e60` / `d7d4422`），**非本次 `a7679ec6..32f00d55` 范围内引入的回归**，原已存在。
- **影响**：浏览器/Electron 意外关闭（非正常 `stop()`）时，最后一次 flush 之后的已写 chunk 可能未 flush；更关键的是 FileSystem FileWriter 流未显式 close，依赖浏览器进程退出兜底，理论上存在截断或句柄泄漏风险。正常运行 `stop()` 路径 unaffected（走 `await writer?.close(); writer = null`，顺序正确）。
- **处置**（commit `8d4a933`）：`flushBuffer` 改为接收 writer 参数（内部不再读模块级 `writer`），`handlePageHide` 先捕获局部引用再置空，`flush + close` 均能执行到。新增回归测试断言 pagehide 后 `write`/`close` 被真正调用。修复同时覆盖 `onScopeDispose` 复用的会话销毁路径。
