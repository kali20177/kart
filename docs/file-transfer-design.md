# 文件下发功能设计

> 对应 [docs/production-gaps.md](./production-gaps.md) 第 4 点：**文件发送（二进制整包下发）**。
> 本文为实现前设计稿，落地时按「实现步骤」分阶段推进。

## 1. 背景与目标

当前 `InputComposer` 只能手敲文本/HEX，`serial.send()` 把单段文本/HEX 转字节、追加行尾后一次性 `driver.write()`。无法满足：

- **固件烧录 / bin 下发**：几十 KB ~ 几 MB 的二进制，必须分包、按设备节奏推进、可断点续传。
- **批量回灌**：把录制的日志/传感器流重放给设备。
- **鲁棒性测试**：高压下发、循环发送、注入错误，验证设备缓冲与错误恢复。

目标：设计一种**类聊天软件**的文件下发体验——选文件后在消息流里出现一条「文件气泡」，带进度条、速率、ETA，可暂停/继续/中止/重试——其下垫一层面向嵌入式场景的**鲁棒传输引擎**（分包、限速、ACK 流控、重试、CRC、断点续传、循环、错误注入）。

### 设计原则

1. **UX 层与引擎层分离**：聊天式 UX 不依赖引擎细节；引擎可独立测试。
2. **一份引擎、多种模式**：用配置项切换 S1~S4 场景，而非多套代码路径。
3. **沿用现有抽象**：经 `SerialDriver.write()` 下发（Mock / Web Serial 通用）；TX 字节计入 `serial.txBytes`；遵守 `shallowRef` + rAF 批处理的高频更新范式（同 messages / waveform store）。
4. **不污染消息流**：一次下发默认只产生**一条文件气泡**（而非每包一条），避免长文件撑爆 `bufferLimit`。

---

## 2. 场景分析（嵌入式实际）

| 场景 | 设备侧行为 | 引擎需求 |
|---|---|---|
| **S1 原始整包下发** | 设备自行消费字节流（自管分帧/落 flash） | 仅限速，不分包或大分包，无 ACK |
| **S2 bootloader 固件上传** | 收一包 → 写 flash → 回 ACK/NACK | 分包 + 协议封装 + ACK 流控 + 重试 + CRC |
| **S3 鲁棒性压测** | 被动接收，验证缓冲/恢复 | 循环下发、变速率、错误注入 |
| **S4 断点续传** | 掉线/复位后从已知偏移继续 | `startOffset` + seq 对齐 |

### 与聊天软件的关键差异

聊天文件传输走 TCP，可靠性由传输层保证；**串口是裸 UART**——无传输层可靠性、无流控（除非硬件流控或自建）。因此「类聊天 UX」必须叠在自建可靠引擎之上：

- 进度条背后是 **ACK 驱动的真实推进**（设备确认收到才前进），不是盲目 `write()` 完即 100%。
- 速率受设备 flash 写入速度约束，而非仅受波特率约束 → ACK 流控天然适配。
- 中止/断线后状态明确（已发送字节数、失败包号），可续传。

---

## 3. 用户体验设计（类聊天）

### 3.1 入口

- `InputComposer` 发送按钮旁新增 **📎 文件** 按钮 → 打开 `FileTransferDialog`。
- 支持把文件**拖拽**到输入框直接触发（类微信拖拽发文件）。

### 3.2 文件气泡（消息流内）

文件下发在消息列表里渲染为**一条特殊的 TX 气泡**（不是 N 条包气泡）：

```
┌─────────────────────────────────────────┐
│ TX ▸  14:32:05.120   📎 firmware.bin    │
│                     262,144 B           │
│ ┌─────────────────────────────────────┐ │
│ │██████████████░░░░░░░░░░░░░░  54%    │ │  ← 线性进度条
│ └─────────────────────────────────────┘ │
│ 512/1024 包 · 12.4 KB/s · ETA 9s · 发送中│
│                          ⏸ ⟲ ⏹ ↻ 详情 │  ← hover 操作
└─────────────────────────────────────────┘
```

- 进度条：已确认字节 / 总字节（ACK 模式下=已 ACK 字节；原始模式=已 write 字节）。
- 状态徽章：`排队 / 发送中 / 已暂停 / 已完成 / 已失败 / 已中止`。
- hover 操作：`⏸暂停 / ▶继续 / ⏹停止 / ↻重试 / 📋详情`。
- 已完成/失败后气泡保留（可「重发」），样式对应 `bubble-tx` 配色。

### 3.3 配置对话框 `FileTransferDialog`

| 区 | 字段 |
|---|---|
| 文件 | 拖拽区 + 选择按钮；显示文件名/大小/SHA-256（前 8 位）预览 |
| 预设 | 下拉：`原始整包下发` / `STM32 ISP(256B·ACK)` / `ESP32(4KB·ACK)` / `鲁棒性压测(循环)` / `自定义` |
| 分包 | `chunkSize`（预设 select + 自定义，含 64/128/256/512/1024/4096/8192）、`chunkSuffix`（行尾/分隔符） |
| 限速 | `interChunkDelay`(ms)、`bytesPerSecond`(B/s，0=不限) |
| 协议 | `framing`（raw / len-prefix / seq-crc）、`waitForAck` + `ackMode`(any/byte/echo-crc) + `ackByte`(默认 0x06) + `ackTimeout`(ms) |
| 鲁棒性 | `retries`、`startOffset`(断点续传)、`repeat`(循环次数)、`logEachChunk`(调试) |
| 高级（折叠） | 错误注入：`corruptEveryN`、`skipAckEveryN` |

底部：`开始下发`（未连接禁用并提示）。

### 3.4 状态条

`StatusBar` 在有活跃下发时显示一行紧凑信息：`📎 firmware.bin 54% · 12.4 KB/s · ⏸停止`，点击可呼出对话框。

---

## 4. 整体架构

```
┌─────────────── UX 层 ───────────────┐
│ FileTransferDialog  FileTransferBubble │  配置 / 进度展示 / 操作
└───────────────┬──────────────────────┘
                │ 调用 start/pause/resume/abort
┌─────────────── 引擎层 ──────────────┐
│            transfer store             │  调度循环 + 状态机
│  ┌──────────┬───────────┬──────────┐ │
│  │ chunk-   │ rate-limit│  crc     │ │  纯逻辑（可单测）
│  │ framer   │ (token    │          │ │
│  │          │  bucket)  │          │ │
│  └──────────┴───────────┴──────────┘ │
└───────────────┬──────────────────────┘
                │ serial.sendRaw(bytes) / serial.onData (ACK)
┌─────────────── 驱动层 ──────────────┐
│        SerialDriver (Mock/WebSerial)  │  ← 阶段 2 替换点，引擎无感
└──────────────────────────────────────┘
```

引擎层经 `serial.sendRaw()` 下发、经 `serial.onData()` 收 ACK；不直接持有 driver。换 Web Serial 时引擎零改动（符合项目「store 依赖接口」原则）。

---

## 5. 核心类型（`src/types.ts` 新增）

```ts
/** 文件下发状态机 */
export type TransferStatus =
  | 'queued'      // 已入队未开始
  | 'sending'     // 发送中
  | 'paused'      // 已暂停
  | 'completed'   // 已完成
  | 'aborted'     // 用户中止
  | 'error'       // 失败（重试耗尽 / 写错误 / 断线）

/** 分包协议封装 */
export type ChunkFraming =
  | 'raw'         // 裸字节
  | 'len-prefix'  // [lenLE16] + payload
  | 'seq-crc'     // [seqLE16][lenLE16] + payload + [crc16LE]  （bootloader 帧）

/** ACK 匹配策略 */
export type AckMode = 'any' | 'byte' | 'echo-crc'

/** 文件下发配置（对话框可编辑，最后一次配置持久化） */
export interface FileTransferConfig {
  chunkSize: number        // 0 = 不分包，整包下发
  interChunkDelay: number  // 包间延时 ms（0 = 无）
  bytesPerSecond: number   // 字节速率上限 B/s（0 = 不限）
  retries: number          // 单包失败重试次数
  framing: ChunkFraming
  chunkSuffix: LineEnding  // 封装后是否追加行尾/分隔符
  waitForAck: boolean
  ackMode: AckMode
  ackByte: number          // ACK 字节（ackMode='byte'），默认 0x06；NACK 默认 0x15
  ackTimeout: number       // ACK 超时 ms
  startOffset: number      // 断点续传起始偏移（字节）
  repeat: number           // 循环次数（0=单次）
  logEachChunk: boolean    // 调试：每包另起一条 TX 帧气泡
  injectCorruptEveryN: number  // 0=off；每 N 包破坏 CRC 触发 NACK→重试
  injectSkipAckEveryN: number  // 0=off；每 N 包忽略 ACK（模拟丢包）触发超时→重试
}

/** 一次下发的运行时状态（rAF 批处理刷新到 UI） */
export interface FileTransferState {
  id: string
  filename: string
  size: number
  status: TransferStatus
  sent: number             // 已（确认）下发字节
  total: number            // 文件总字节
  currentChunk: number
  totalChunks: number
  pass: number             // 当前循环轮次（1 起）
  startedAt: number        // Date.now()
  elapsedMs: number
  bytesPerSec: number      // 平滑后的实时速率
  failedChunk?: number     // 失败包号（error/aborted 时）
  error?: string
}
```

### `Message` 扩展（`src/types.ts`）

```ts
export interface Message {
  id: number
  direction: Direction
  bytes: Uint8Array
  timestamp: number
  error?: string
  kind?: 'frame' | 'file'   // 新增，缺省 'frame'（向后兼容）
  transferId?: string        // kind==='file' 时指向 transfer store
}
```

文件气泡的 `bytes` 留空（或存首/尾 16 字节做 HEX 预览）；进度等活态由 `transferId` 从 transfer store 实时读取——**不把进度塞进 Message**（Message 是 `shallowRef` 数组里的不可变快照，逐帧 mutate 会触发响应式抖动）。

---

## 6. 传输引擎设计（`src/stores/transfer.ts`）

### 6.1 调度循环（核心）

单条活跃下发一个 async pump（不用 `setInterval`——会漂移且无法 `await write`）：

```ts
async function pump(t: TransferCtx) {
  while (!t.done && !t.aborted) {
    await t.resumeGate          // 暂停时阻塞在此
    const chunk = nextChunk(t)  // 按 startOffset/seq 取切片
    const wire = frame(chunk, t.seq, t.config)
    maybeInjectError(wire, t)   // 鲁棒性：可选破坏 CRC
    const ok = await sendWithRetry(t, wire)
    if (!ok) { fail(t); break }
    advance(t, chunk.length)    // sent += chunk.length; seq++
    flushProgressThrottled()    // rAF 批处理刷新状态
    await rateLimitDelay(t)     // 限速（见 6.2）
  }
  finalize(t)
}
```

暂停/继续/中止通过信号量与标志位实现：`resumeGate` 是一个可 resolve 的 Promise 桩；`pause()` 把它换成新 pending Promise，`resume()` resolve 之；`abort()` 置 `t.aborted=true` 并 resolve 当前 gate。

### 6.2 限速（`src/utils/rate-limit.ts`，纯逻辑可测）

两个独立旋钮，取更严者：

- **包间延时** `interChunkDelay`：每包后固定 sleep。粗粒度，bootloader 常见。
- **字节速率** `bytesPerSecond`：令牌桶平滑限速。实现：维护 `sentSinceStart`，理论应发 `bytesPerSecond * elapsed/1000`；若 `sentSinceStart` 超出理论值，sleep 差额。比 `setInterval` 精确、不漂移。

```ts
// 伪码：每包后计算需要等多久
function paceDelay(now, startedAt, sent, bps): number {
  if (!bps) return interChunkDelay
  const target = bps * (now - startedAt) / 1000   // 此刻理论已发
  const deficit = sent - target                    // 超前量
  return Math.max(interChunkDelay, deficit > 0 ? (deficit / bps) * 1000 : 0)
}
```

注入可控时钟（`now()` 与 `sleep()` 由参数传入）以便单测。

#### 6.2.1 波特率 vs 字节速率--两个正交的限速层

`bytesPerSecond`（字节速率）容易和连接栏的 **波特率** 混淆，但二者作用在完全不同的层：

```
你的代码                OS 缓冲区              UART 硬件             设备
  │                       │                      │                    │
  │ writer.write(64B)     │                      │                    │
  │ ────────────────────> │  瞬间塞入            │                    │
  │  (字节速率控制这一步)  │  ──按波特率节流──>   │ ──线路 bit 流──>  │
  │                       │  的频率              │                    │
```

- **波特率 = 物理层硬天花板**（由硬件决定，无法被软件突破）
  - `port.open({ baudRate: 115200 })` 后，UART 芯片以 115200 bit/s 在铜线上推 bit。
  - 一个字节在 8N1 下占 10 bit（1 起始 + 8 数据 + 1 停止），故 **115200 baud ≈ 11520 B/s**。
  - 即使 JS 瞬间 `writer.write(1MB)`，OS 缓冲区收到后仍按这个速率慢悠悠往外吐。

- **字节速率 = 应用层软节流**（由你的代码决定，可任意设）
  - 控制的是「JS 多频繁往 `writer.write()` 塞数据」。
  - 目的不是限线路速度（波特率已经做了），而是**保护设备端的处理能力**。

**有效速度 = min(波特率对应 B/s, 字节速率)**。

#### 6.2.2 为什么两者都必要--典型烧录场景

设备 flash 写入速度只有 64 B/s，但串口连在 115200 baud：

| 不设字节速率 | 设字节速率 64 B/s |
|---|---|
| JS 瞬间塞满 OS 缓冲区 | JS 每 ~1s 塞 64 B |
| OS 按 11520 B/s 推上线 | OS 按 11520 B/s 推上线 |
| 设备收 11520 B/s，但只能写 64 B/s | 设备收 64 B/s，恰好能消化 |
| **设备 RAM 缓冲爆 -> 丢包** | ✅ 稳定 |

所以字节速率本质是模拟「设备侧处理瓶颈」，和波特率是正交的两个约束。`FileTransferDialog` 在字节速率输入框右侧实时显示当前波特率对应的上限（`波特率上限 ≈ 11520 B/s`），超限时变橙警告（`超过波特率上限 11520 B/s，按波特率为准`），避免用户误以为把字节速率调高就能突破物理线路速度。

#### 6.2.3 Mock 阶段的局限

阶段 1 的 `MockSerialSource.write()` 立即返回，不按波特率节流（见 `src/mock/MockSerialSource.ts`）。故当前看到的传输速率纯粹是 `transfer.ts` 里 `sleep()` 软节流的结果，波特率这个数字目前对传输速度**没有真实约束**。**阶段 2 接入 Web Serial 后，波特率才会成为真实物理天花板**，届时上述 UI 提示与 `maxBps` 计算（按当前 `dataBits/parity/stopBits` 推算 bit/字节）即可准确反映实际行为。UI 已按未来真实行为设计，后端切换时无需改动前端。

```ts
// FileTransferDialog.vue -- 波特率 -> 物理层最大字节速率
const maxBps = computed(() => {
  const o = serial.options
  const bitsPerByte = 1 + o.dataBits + (o.parity !== 'none' ? 1 : 0) + o.stopBits
  return Math.floor(o.baudRate / bitsPerByte)
})
```

### 6.3 分包（`src/utils/chunk-framer.ts`，纯逻辑可测）

- `chunkSize=0`：整包一次 `write`（S1）。
- 否则按 `chunkSize` 切片，末包可短；`totalChunks = ceil(size/chunkSize)`。
- 切片用 `ArrayBuffer` 视图零拷贝（`new Uint8Array(buf, off, len)`），不重读文件。
- `startOffset`：从该字节起切，`seq = floor(startOffset/chunkSize)`（S4 续传，seq 与设备对齐）。

### 6.4 协议封装 + CRC（`src/utils/crc.ts` 新增）

CRC 工具同时推进 production-gap 第 3 点（发送带 CRC）：

```ts
crc16(data, 'modbus' | 'ccitt')   // 常见 bootloader 校验
crc32(data)                        // 整文件校验
checksum8(data)                    // 累加和
```

`frame(chunk, seq, config)` 按 `framing` 产出线字节：

| framing | 线格式 |
|---|---|
| `raw` | `payload` |
| `len-prefix` | `[len & 0xFF, len>>8]` + `payload` |
| `seq-crc` | `[seq & 0xFF, seq>>8][len & 0xFF, len>>8]` + `payload` + `[crc16 & 0xFF, crc16>>8]` |

`chunkSuffix` 在封装后追加（设备按行缓冲时用）。

### 6.5 ACK 流控与重试（S2 核心，鲁棒性关键）

`waitForAck=true` 时，`sendWithRetry`：

1. `serial.sendRaw(wire)` 写出。
2. 计入 `serial.txBytes`；若 `logEachChunk` 则 `messages.addTx(wire)`。
3. 在 `ackTimeout` 内等 ACK（订阅 `serial.onData`，按 `ackMode` 匹配）：
   - `any`：收到任意字节即 ACK。
   - `byte`：收到 `ackByte`(0x06)=ACK；收到 NACK(0x15)=立即重试。
   - `echo-crc`：设备回吐 CRC，与本包 CRC 比对。
4. ACK → 返回 ok；NACK/超时 → `retries--` 并重发本包（**seq 不变**，设备可去重）。
5. 重试耗尽 → 返回失败，pump 终止，状态 `error`，记录 `failedChunk`。

ACK 匹配器维护一个 RX 字节队列（`serial.onData` 推入），匹配消费、超时清空。**仅活跃下发时订阅**，完成/中止即退订。

### 6.6 断点续传（S4）

- `startOffset` 决定起始切片与 seq。
- 来源：设备 bootloader 复位后上报当前偏移（v1 手动填入对话框；未来可解析设备 `RESUME @<offset>` 自动填）。
- 续传前可选发送一个「续传声明帧」（设备协议若需要）——v1 不强求，留 `chunkSuffix`/`framing` 表达。

### 6.7 循环下发（S3）

`repeat>0`：完成一轮后 `pass++`，重置 `sent=0`/`seq=0`，继续下一轮，直到 `pass>repeat`。进度条显示「轮次 pass/repeat」与轮内进度。用于压测设备长时间稳定性。

### 6.8 错误注入（S3 鲁棒性验证，默认关）

- `injectCorruptEveryN`：每 N 包把 CRC 字节翻转 → 触发设备 NACK → 验证重试路径。
- `injectSkipAckEveryN`：每 N 包本地忽略设备 ACK → 触发超时 → 验证超时重试。

仅用于验证**设备侧**的错误恢复，调试时开启，默认 0。

### 6.9 进度刷新（rAF 批处理）

活态字段（`sent/currentChunk/elapsedMs/bytesPerSec`）先用普通变量累积，每帧至多一次 `triggerRef` 刷到响应式 `state`（同 messages store `scheduleFlush` 范式）。速率用指数移动平均平滑，避免抖动。

### 6.10 生命周期与断线

- `watch(serial.connected)`：断线时 `abort(activeId, reason='disconnect')`，状态置 `error`，气泡标「连接断开」——与 `InputComposer` 循环发送断线处理一致。
- 同时只能有一个活跃下发（串口是独占资源）；新 `start` 前若有活跃，提示先停止。
- `transfers` 数组保留最近 N 条（如 20）历史用于气泡「重发」。

---

## 7. 与现有架构集成

### 7.1 `src/stores/serial.ts`

新增 `sendRaw` 供引擎调用（不追加行尾、不强制建气泡）：

```ts
/** 原始字节下发（文件引擎/重发用）。record=true 时建一条 TX 帧气泡。 */
async function sendRaw(bytes: Uint8Array, record = true): Promise<{ ok: boolean; error?: string }> {
  if (!connected.value) return { ok: false, error: '未连接' }
  try {
    await driver.write(bytes)
    txBytes.value += bytes.length
    if (record) messages.addTx(bytes)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (record) messages.addTx(bytes, msg)
    return { ok: false, error: msg }
  }
}
```

`onData` 已暴露（波形 store 在用），ACK 订阅复用。

### 7.2 `src/stores/messages.ts`

新增 `addFileTransfer`：

```ts
function addFileTransfer(transferId: string, filename: string, size: number) {
  pending.push({ id: nextId++, direction: 'tx', bytes: new Uint8Array(0),
                 timestamp: Date.now(), kind: 'file', transferId })
  scheduleFlush()
}
```

### 7.3 `src/components/MessageBubble.vue`

`kind==='file'` 时委托给 `FileTransferBubble.vue` 渲染（进度卡），不渲染 HEX/ASCII body。`bytes` 为空时不显示「N B」长度，改由文件气泡显示文件大小。

### 7.4 `src/components/InputComposer.vue`

- 发送按钮左侧加 📎 按钮 → emit `open-file-transfer`。
- 输入框 `dragover/drop`：拖入文件时 emit 同事件（带 `File`）。
- 活跃下发时禁用普通发送或提示（避免争抢串口）。

### 7.5 `src/App.vue`

挂载 `FileTransferDialog`（受控显隐 + 预填拖入的 `File`），与 `AsciiTable`/`SettingsModal` 同级。

---

## 8. 文件结构与改动清单

**新增**

| 文件 | 职责 |
|---|---|
| `src/utils/crc.ts` (+`.test.ts`) | crc16/crc32/checksum8 |
| `src/utils/chunk-framer.ts` (+`.test.ts`) | 切片 + 封装 + 末包短包 |
| `src/utils/rate-limit.ts` (+`.test.ts`) | 令牌桶限速（注入时钟可测） |
| `src/stores/transfer.ts` (+`.spec.ts`) | 引擎：pump / 状态机 / ACK / 重试 / 续传 / 循环 / 注入 |
| `src/components/FileTransferDialog.vue` | 配置 + 预设 + 文件选择 |
| `src/components/FileTransferBubble.vue` | 消息流内文件气泡（进度条 + 操作） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `FileTransferConfig/State`、`ChunkFraming`、`TransferStatus`、`AckMode`；`Message` 加 `kind/transferId` |
| `src/stores/serial.ts` | 新增 `sendRaw` |
| `src/stores/messages.ts` | 新增 `addFileTransfer` |
| `src/components/InputComposer.vue` | 📎 按钮 + 拖拽 |
| `src/components/MessageBubble.vue` | `kind==='file'` 委托渲染 |
| `src/components/StatusBar.vue` | 活跃下发紧凑条（可选） |
| `src/App.vue` | 挂载 `FileTransferDialog` |
| `src/locales/zh-CN.ts` / `en-US.ts` | `fileTransfer` 命名空间 |

---

## 9. 测试计划（沿用项目「纯逻辑可单测」约定）

- `crc.test.ts`：标准向量（MODBUS/CCITT 已知输入→已知输出）。
- `chunk-framer.test.ts`：三种 framing 字节布局、末包短包、`startOffset` 切片与 seq 对齐、`chunkSuffix` 追加。
- `rate-limit.test.ts`：注入假时钟，验证超前时 sleep 差额、不限速时 0、包间延时叠加。
- `transfer.spec.ts`（用 fake driver + fake timers + 可控 RX）：
  - 原始整包完成、分包完成；
  - 暂停/继续/中止；
  - ACK `any`/`byte`/`echo-crc` 匹配；
  - NACK→重试→成功；超时→重试→耗尽→`error`；
  - `repeat` 循环计数；
  - `startOffset` 续传 seq 对齐；
  - 断线→`abort`；
  - 错误注入触发重试路径。

---

## 10. i18n（`fileTransfer` 命名空间，zh-CN / en-US）

状态：`queued/sending/paused/completed/aborted/error`；配置项标签（分包/限速/协议/鲁棒性/高级）；预设名；对话框文案；toast（`started/paused/resumed/aborted/completed/failed`）；文件气泡操作（`pause/resume/stop/retry/details`）。

---

## 11. 取舍与未决项

| 项 | 决策 | 理由 |
|---|---|---|
| 进度存哪 | transfer store（rAF 批处理），不进 Message | Message 是不可变快照；活态进它会抖动 |
| 每包是否建气泡 | 默认否（`logEachChunk` 可开） | 长文件撑爆 bufferLimit；调试时再开 |
| ACK 复杂度 | v1 含 `any/byte/echo-crc` 三策略 | 用户明确要求鲁棒性测试，ACK/重试是刚需 |
| 写入背压 | v1 不处理（`driver.write` 一次性 await） | Web Serial `write` 返回即 OS 接收；真背压待阶段 2 驱动支持 |
| 大文件流式读 | v1 用 `File.arrayBuffer()`（数百 MB 内 OK） | 简单；超大文件流式留后续 |
| 续传声明帧 | v1 不强求，靠 `startOffset`+seq | 协议无关；具体声明由 `framing`/`chunkSuffix` 表达 |
| 错误注入 | 进 v1（默认关） | 直接服务 S3 鲁棒性压测场景 |
| 多任务并发 | v1 单活跃（串口独占） | 串口物理上独占；队列留后续 |

---

## 12. 实现步骤（分阶段）

**阶段 A — 纯逻辑基座（无 UI，全可测）**
1. `utils/crc.ts` + 测试。
2. `utils/chunk-framer.ts` + 测试。
3. `utils/rate-limit.ts` + 测试。

**阶段 B — 引擎与类型**
4. `types.ts` 新增类型 + `Message` 扩展。
5. `stores/serial.ts` 加 `sendRaw`。
6. `stores/messages.ts` 加 `addFileTransfer`。
7. `stores/transfer.ts` 引擎（pump/状态机/限速/封装）+ spec（fake driver）。

**阶段 C — ACK/重试/续传/循环/注入**
8. 引擎补 ACK 订阅与匹配、重试、`startOffset`、`repeat`、注入；补 spec。

**阶段 D — UI**
9. `FileTransferBubble.vue` + `MessageBubble` 委托。
10. `FileTransferDialog.vue`（含预设）。
11. `InputComposer` 📎 + 拖拽；`App.vue` 挂载；`StatusBar` 紧凑条。
12. i18n 两语言包。

**阶段 E — 收尾**
13. 更新 `docs/production-gaps.md` 第 4 点标 ✅。
14. `npm run typecheck` + `npm test` 全绿。
```

逐阶段交付，每阶段可独立 typecheck/test 验证。
