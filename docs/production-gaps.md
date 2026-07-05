# 生产环境缺失功能与已知问题

本文件记录串口调试助手作为**生产环境工具**尚缺的功能（按优先级分层），以及开发中发现的已知技术问题。供后续任务规划与排期参考。

> 最近更新：2026-07-05。已完成项标注 ✅。

## 一、生产环境缺失功能

### 核心调试能力（高优先级，不补日常用会很难受）

1. **帧间时间差 Δt** — `MessageBubble` 只显示绝对时间 `HH:MM:SS.mmm`，缺与上一帧的 Δt、会话起点 elapsed。嵌入式调试时序刚需。
2. ✅ **搜索只能过滤、不能高亮，且搜不了 HEX** — 已完成：文本/HEX 双模式搜索（HEX 复用 `parseHexInput`，宽容分隔）、命中高亮（原生配对：text+ascii / hex+hex；交叉配对仅过滤+导航+flash，避免字节/字符偏移错位）、上一项/下一项导航（`当前/总数` + 自动滚动 + 活动色 + flash）、当日时间范围筛选（`HH:MM:SS[.mmm]`，非法红框）。**不做正则**（嵌入式调试用处不大）。匹配逻辑抽到 `src/utils/search.ts` + `hex.ts#findByteRanges`，响应式编排抽到 `src/composables/useMessageSearch.ts`，均有单测。已知限制：交叉配对无内联高亮、时间筛选不支持跨午夜区间。
3. **发送无 CRC/校验和，接收无校验** — `serial.send` 只拼行尾。嵌入式协议普遍带 CRC8/16/32 或累加和。接收侧 `Message.error` 只用于发送失败，无校验位不符标记。
4. **文件发送（二进制整包下发）** — `InputComposer` 只能手敲文本/HEX。固件烧录、bin 下发、批量回灌需选文件发送，可选限速/分包。
5. **DTR/RTS/Break 控制** — `SerialDriver` 只有 `getSignals`（只读），无 `setSignals`。ESP32/STM32 bootloader、复位、ISP 靠 DTR/RTS 组合 + Break。前端无按钮，接口契约无。〔依赖 Web Serial 驱动〕
6. ✅ **暂停时数据直接丢弃** — 暂停时数据仍不缓冲保留（波形追加缓冲无意义：恢复瞬间刷新长段 + 超缓冲区截断后数据不全），恢复时通过 warning toast 提示用户缺失数据的时间段（`HH:MM:SS.mmm – HH:MM:SS.mmm (Xs)`），消息列表与波形图均有各自独立提示。
7. **布局与发送历史不持久化** — 右栏宽度（`App.vue` rightWidth）、输入框高度（`InputComposer` DOM）不存；`useSendHistory` 仅内存。每天重开归零。
8. ✅ **自定义波特率** — 已完成（filterable+tag 输入、自定义档位+标注、预设标注、校验、持久化）。

### 专业工具进阶预期（中优先级）

9. **统计面板太薄** — `StatusBar` 只 RX/TX 字节；`rxFrames` 定义了未显示。缺帧数、B/s、帧/s、错误帧、会话时长、帧间隔统计。
10. **标记/注释/分隔** — 无法在流里插 marker/备注。
11. **会话录制与回放** — 只有导出 txt，无导入回放。
12. **导出格式单一** — `exportLog` 只 txt。缺 CSV、原始二进制、按筛选导出、hex+ascii 双列。
13. **结构化协议解析器** — 帧切分解决了切帧，无"帧内字段（header/len/cmd/payload/crc）可配置渲染"。无 Modbus 等通用协议解码。
14. **单连接，不支持多端口并发** — `serial` store 单例 driver。同时盯多设备做不到。〔依赖驱动〕
15. **快速命令不支持变量/宏替换** — `QuickCommand.payload` 静态。缺计数器、时间戳、CRC 占位；无每命令独立循环发送。
16. **波形缺测量与导出** — `WaveformChart` 有暂停回看，缺游标读值、双游标 Δ、Y 轴单位/量程、V/div & ms/div、触发线、每通道自定义颜色、CSV 导出。
17. **自动重连是空开关** — `autoReconnect` 设置存在，无重连逻辑，无掉线提示。〔依赖驱动〕

### 打磨项（低优先级）

18. **清空无确认/无撤销** — `messages.clear` 直接清空，误点丢失。
19. **缓冲满无感知** — 超 `bufferLimit` 静默裁剪，无"已丢弃 N 帧"提示。
20. **全局快捷键缺失** — 只 Ctrl+Enter 发送、Alt+↑↓ 历史。连接/清空/切视图/暂停无快捷键，无命令面板。
21. **关键字告警** — 收到特定模式无声音/通知。
22. **端口元信息缺失** — `listPorts` 只字符串数组，无 VID/PID/厂商/占用提示。〔依赖驱动〕
23. **复制能力弱** — 单帧复制带时间戳/方向 ✅；多选批量复制 / 导出 txt / 删除 ✅（全选即"复制全部可见"）；仍缺 CSV 行。
24. **`useStorage` 同步无容量保护** — 全同步 localStorage，阶段 2 换 electron-store（async）接口签名要改。

### 边界说明

- 第 5、14、17、22 项依赖 Web Serial 驱动实现相应能力，前端 UI 可先做但落地需驱动支持（属"阶段 2 路线图"）。
- 其余各项（1–4、6–13、15–16、18–24）纯前端可独立完成。

---

## 二、已知技术问题

### ✅ `vite.config` 的 `test.environment`「未生效」（已排查并修复）

- **原误判**：曾以为 `environment: 'jsdom'` 没生效、测试跑在 node 环境。
- **实况**：jsdom 一直生效（`navigator.userAgent` 为 `jsdom/24.x`，`window`/`document` 均可用）。真正症状只是 `localStorage` 不可用，并抛 `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`。
- **真正根因**：Node 22+ 在 `globalThis` 上装了实验性 `localStorage` 访问器（`--experimental-webstorage`），它是 own property，遮蔽了 jsdom 的 Web Storage。vitest 1.6.1 的 jsdom 环境只把 jsdom window 的「自有可枚举属性」拷到全局，而 jsdom 的 `localStorage` 位于原型链上不会被拷贝，于是全局 `localStorage` 命中 Node 的实验性访问器（getter 返回 undefined + 警告）。**与 `defineConfig` 从 `'vite'` 还是 `'vitest/config'` 导入无关**——二者运行时都原样透传 `test` 字段，仅影响类型标注。
- **修复**：新增 `src/test/setup.ts`，在 `beforeEach` 用 `vi.stubGlobal` 提供内存版 `localStorage`（每用例重置保证隔离），并在 `vite.config.ts` 的 `test.setupFiles` 注册。`serial.spec.ts` 内冗余的 stub 及误判注释已移除。
- **备选（未采用）**：`NODE_OPTIONS=--no-experimental-webstorage` 可让 jsdom 的 localStorage 接管，但该标志仅 Node 22+ 存在，在 Node 20 上会报 `bad option`，跨版本不可移植，故未采用。
- **影响**：不影响生产。现已消除警告，后续 DOM/组件渲染测试（`@vue/test-utils` 挂载）可直接用 jsdom。
