# 终端模式（Terminal Mode）设计

> **注：** 渲染端方案，适用于全部驱动（mock / Web Serial / Electron serialport）。
> **阶段一（MVP）已实施**（见「实施计划」进度勾选）；本文档是后续迭代（尤其阶段三 **vim/nano 全屏编辑**）的蓝图，行文以已实现代码为准。
>
> 关联：`docs/production-gaps.md` 未列此项（全新能力）；复用现有帧切分、`onData` 订阅、虚拟滚动、主题与持久化设施。
> 日期：2026-08-08。状态：阶段一已实施，阶段二部分、阶段三待实施。

## 背景

现有串口助手是**帧气泡**模型：RX 按帧切分策略（gap-timeout / 分隔符 / 定长）切成气泡，发送用 textarea 拼行发送。这个模型适合「发指令收数据」，但**不适用交互式 shell**：

- 嵌入式 Linux 串口 console（busybox ash / bash + readline）——设备侧行编辑 + **回显**，输出是连续字节流（prompt、彩色命令输出、`\r` 重绘、tab 补全重画整行）；
- Letter Shell（MCU 上常见的交互式 shell，设备侧行编辑 + 回显）——同上。

这类设备的正确交互模型是**物理终端**：按键即时下发、设备回显、屏幕按终端语义（回车/退格/制表/ANSI 转义）重绘。当前气泡模型会把这种连续流切碎、且无法处理 `\r` 重绘与 ANSI 色彩。

目标：为串口助手新增**终端视图**，支持命令行输入，使该工具可以直接连嵌入式 Linux 串口或 Letter Shell 交互调试，同时**保留**现有气泡/波形/录制能力（终端与气泡并行采集，互不干扰）。

## 目标与场景

| 场景 | 现状 | 终端模式目标 |
| --- | --- | --- |
| 嵌入式 Linux 串口 console（`bash`+readline / busybox ash，设备回显+行编辑） | 气泡被切碎、无法用 ←/→ 等键、ANSI 变乱码 | 按键直通、终端视口正确重绘、tab 补全/`\r` 重绘正常显示 |
| Letter Shell（MCU 交互式 shell，设备侧回显+编辑） | 同上 | 同上 |
| 不回显的裸设备 / AT 命令 | 可用（发指令收数据） | 提供**本地回显 + 本地行编辑**兜底，体验一致 |

**非目标**（v1 明确不做）：完整 xterm 全屏程序（vim/nano/htop 的 alt-screen，**阶段三目标**，见「实施计划」）；终端内正则搜索；行级时间戳导出。详见「边界与已知限制」。

## 现状（已核实）

- `Session`（[src/session/index.ts](../src/session/index.ts)）在 effectScope 内装配 store **七件套**：`serial / messages / pause / waveform / recorder / transfer / terminal`，全部经 deps 注入接线；`SessionPane.mainView` 已扩展为 `'messages' | 'waveform' | 'terminal'`，选中终端渲染 `TerminalPane`。
- `serial store` 暴露**原始字节双通道**：`onData(cb)`（帧切分**之前**，waveform/recorder/terminal 已用）与 `onTxData(cb)`（driver.write 成功后，recorder 已用）。`serial.sendRaw(bytes, record)` 裸写不追加校验和/行尾——终端直通走 `sendRaw` 且 `record=false`（避免每按键一条 TX 气泡）。
- `FrameSplitter`（[src/composables/useFrameSplitter.ts](../src/composables/useFrameSplitter.ts)）是纯逻辑类、可单测；messages store 用 rAF 批处理刷入 + 环形缓冲裁剪（`droppedFrames`）。terminal store 沿用同样的「纯逻辑 + rAF 批处理 + 上限裁剪」模式。
- `decodeBytes` 用 `TextDecoder`，非流式（一次性 decode，消息路径保留）；**终端多字节字符跨 chunk 到达，走独立流式解码**（见「关键发现 1」）。
- `MessageList` 已用 vue-virtual-scroller；终端 `TerminalPane` 用**固定行高 RecycleScroller**。
- 设置：`AppSettings.terminal`（[src/types.ts](../src/types.ts)）已落地，settings store 提供默认值并对旧配置浅合并兜底；`MockScenarioId` 已扩展 `'shell'`。**SettingsModal 的「终端」设置页尚未实现**（阶段二，见「实施计划」）。
- Mock 已新增 `shell` 场景（`MockShell`：设备侧回显 + 行编辑 + tab 补全 + 带 ANSI 色的命令应答），无硬件自测终端效果可用。

## 关键发现

1. **多字节字符跨 chunk**：终端输出为连续流，UTF-8/GBK 多字节字符会被分割到不同 `onData` 批次。必须用 `TextDecoder(enc, { stream: true })` 流式解码（跨批次保留 partial），否则每帧出现 U+FFFD 乱码。解码器状态存于 terminal store（已实现），连接断开时 `flush` 一次。
2. **终端必须拿原始字节、走独立渲染管线**：不能复用 `ingestRx`（会被帧切分）。终端 store 经 `serial.onData` 订阅（与 waveform 同机制），messages store 继续并行摄入——用户切回「消息」tab 仍能看到帧日志（含搜索/导出/标注），终端与气泡**双写并存**（已实现）。
3. **TX 气泡噪声**：字符直通模式每按键都会触发 `sendRaw`；若 `record=true` 会在 messages store 里按次累积 TX 气泡（虽然被环形裁剪封顶，但污染消息日志）。终端路径统一 `record=false`（已实现），TX 记录仍由 recorder 的 `onTxData` 捕获（录制不受影响）。
4. **现有 `encodeText` 实际无视 encoding、统一 UTF-8 编码**（[src/utils/encoding.ts](../src/utils/encoding.ts)）。终端直通发送的是按键字节，不经过编码转换（键盘字符 → 对应 UTF-8/ASCII 字节，UTF-8 下 ASCII 兼容），与现状一致即可；GBK 键盘输入属边缘场景，v1 按 UTF-8 发送。
5. **行尾约定**：串口 console 惯例 Enter 发 `\r`（多数 shell 兼容 `\n`）；Letter Shell 可配。复用现有 `LineEnding` 设置（默认 `cr`），行发送与字符直通 Enter 均追加所选行尾。
6. **退格字节因设备而异**：Linux console 收 `0x7F`（DEL），部分 MCU 板要 `0x08`（BS）。提供设置项，默认 `0x7F`。
7. **性能风险与已知教训直接相关**：终端高频输出比气泡更凶（逐行 vs 逐帧）。必须沿用 production-gaps「巨型气泡冻结」的护栏思路——rAF 批处理、**固定行高虚拟滚动**（RecycleScroller，勿用 DynamicScroller）、**脏行增量补丁**、滚动上限 + 丢弃计数。ANSI 解析器对畸形序列**绝不抛错**（忽略未知序列，有界状态）。
8. **终端是双向协议（vim 等全屏程序必需回复通道）**：串口无 `LINES/COLUMNS` 环境变量，vim 启动时会**查询终端**——发 `ESC[6n`（光标位置报告 CPR）或 `ESC[18t`（窗口尺寸）确定行列，发 `ESC[>c`/`ESC[c`（设备属性 DA）协商色彩与特性。**终端必须回发 ANSI 应答**（`ESC[row;colR` / `ESC[8;rows;colst` / `ESC[>0;…c`），否则 vim 退保守模式、渲染错乱。这意味着 terminal store 不止接收，还需一条**回发通道**：deps 注入 `send` 句柄（`serial.sendRaw(bytes, false)`），解析器识别查询序列并生成应答。**CPR/DA 应答已实现**，这是支持 vim/nano 的**架构级前提**（见 D6）。

## 设计决策

### D1：终端是「会话内第三视图」，不是新模式开关

`SessionPane.mainView: 'messages' | 'waveform' | 'terminal'`（已实现）。选中终端视图时渲染 `TerminalPane`（视口 + 输入条），隐藏 `MessageList + InputComposer`。理由：
- 与现有视图 tab 模式一致，改动最小；
- 终端数据**后台持续采集**，切回消息 tab 可看帧日志/搜索/导出；
- 每会话独立（多会话 tab 各自带终端）。

### D2：终端渲染用「单元格网格屏幕缓冲」，不是逐行流

核心是**类 xterm 的 screen-buffer**（cell 网格 + 光标 + SGR 状态 + 回滚），配合**有界 ANSI 子集解析器**（已实现，见 [src/terminal/screen-buffer.ts](../src/terminal/screen-buffer.ts)）。理由：嵌入式 Linux bash/readline 与 Letter Shell 都会用光标寻址重绘（readline 补全、`\r`+空格清行重画、行首定位），纯逐行流渲染会出乱码。二者皆需 cell 网格才能正确显示。

### D3：输入用「终端行规」，二选一传输模式 + 回显开关

单一输入组件 `TerminalInput`（已实现），内含本地行缓冲（line 模式用原生 `<input>`）与历史（复用 `useSendHistory`）。核心二选一：

| 传输模式 | 编辑方 | 发送时机 | 适配对象 |
| --- | --- | --- | --- |
| **字符直通 `char`**（默认） | 设备侧（远程行编辑+回显） | 每按键即时透传原始字节（含控制键转义） | 嵌入式 Linux console / Letter Shell |
| **行发送 `line`** | 本地（光标/退格/历史/Home/End） | Enter 发送 `行 + 行尾` | 不回显裸设备 / AT 命令 |

**本地回显 `echo`**（开关）：默认 **OFF**（两类目标设备均自身回显，开则双回显）。打开后，下发字节（char 模式按键 / line 模式已发送行）立即回显到终端视口，适配不回显设备。

| 按键 | char 模式 | line 模式 |
| --- | --- | --- |
| 可打印字符 | 立即发送 | 插入本地行缓冲 |
| Enter | 发送行尾 | 发送 `行 + 行尾`，清缓冲 |
| Backspace | 发送 `0x7F`（可配 `0x08`） | 本地删光标前 |
| ←/→ | 发送 `ESC[D`/`ESC[C`（设备侧移动） | 本地移动光标 |
| ↑/↓ | 发送 `ESC[A`/`ESC[B`（设备侧历史） | 本地历史（复用 useSendHistory） |
| Tab | 发送 `0x09`（设备侧补全） | 本地补全（v1 无 → 发送 `0x09`） |
| Home/End | 发送 `ESC[H`/`ESC[F` | 本地行首/行尾 |
| Ctrl+C / Ctrl+Z / Ctrl+D 等 | 发送 `0x03` / `0x1A` / `0x04` | 同左（透传控制字节，实现中断/挂起） |

> line 模式下 Ctrl 组合默认**透传**为控制字节（保证 Ctrl+C 中断可用），本地编辑走普通按键；不另做 readline 风格的 Ctrl+A/E/U/W（避免语义冲突，见「边界」）。

### D4：TX 在终端视图的呈现

终端视图内**无 TX 气泡**。TX 去向：
- char 模式 + echo OFF：不显示（等设备回显）；echo ON：按键字节回显。
- line 模式 + echo ON：发送行回显到视口。
- 所有路径均 `sendRaw(record=false)`：不污染 messages 帧日志；recorder 经 `onTxData` 照常录制。

### D5：设置与会话

- `AppSettings.terminal` 已落地（见「设置项」）；`persistNow` 自动落盘（settings store 深 watch）。**SettingsModal「终端」页尚未实现**（阶段二）。
- `mainView` 的 `terminal` 与 char/line 快速切换在 TerminalPane 工具栏（视图态随会话；传输模式默认取设置，可临时改——**快速切换暂不落盘**，阶段二统一持久化）。
- 终端 store 尊重全局 pause：暂停时停止摄入（已实现）；恢复时在回滚插一条缺口标记线（阶段二，见「边界」）。

### D6：终端回复通道（设备查询应答）

terminal store 的 deps 增加 `send: (bytes: Uint8Array) => Promise<{ok: boolean}>`（接线为 `serial.sendRaw(bytes, false)`）。解析器识别**查询类序列**并自动应答（**已实现**，见 [src/stores/terminal.ts](../src/stores/terminal.ts) 的 `respondCursor`/`respondDa`）：

| 设备发（查询） | 终端应答 | 状态 |
| --- | --- | --- |
| `ESC[6n`（光标位置 CPR） | `ESC[<row>;<col>R`（当前光标行列） | ✅ 已实现（`respondCursor`） |
| `ESC[c`（主设备属性 DA1） | `ESC[?1;2c`（VT100 兼容应答） | ✅ 已实现（`respondDa`） |
| `ESC[>c`（次设备属性 DA2，vim 查 256 色/特性） | `ESC[>0;<ver>;0c` | ✅ 已实现（`respondDa`，版本回 0） |
| `ESC[18t` / `ESC[14t`（窗口/文本区尺寸） | `ESC[8;<rows>;<cols>t` | ⬜ 未实现（解析器当前忽略 `t` 序列；阶段三随 `setSize` 联动——视口行列由容器尺寸计算，见 TerminalPane `updateSize`） |

应答由 terminal store 基于 ScreenBuffer 光标/行列生成，用注入的 `sendRaw` 回发——**不经过**输入行规，也不建 TX 气泡。CPR/DA 已实现（部分 shell 的 prompt 与 `stty size` 依赖），为阶段三 vim 打底。

## 架构与数据流

```
  SerialDriver.onData（原始字节）
        │
        ├──▶ messages store（FrameSplitter → 帧气泡）   [照旧，切回消息 tab 可看/搜索/导出]
        ├──▶ waveform store（onData 订阅）              [照旧]
        └──▶ terminal store（onData 订阅，终端专属）[已实现]
                ├── AnsiParser（字节流 → 终端操作序列）
                ├── ScreenBuffer（cell 网格 + 光标 + SGR + 回滚）
                └── rAF 批处理 → 脏行补丁 → TerminalPane 虚拟滚动渲染

  TerminalInput（char 直通 / line 编辑 + echo + 历史）[已实现]
        └──▶ serial.sendRaw(bytes, record=false) ──▶ driver.write ──▶ onTxData ──▶ recorder（照旧录制）
```

### 新增文件

```
src/terminal/
  ansi-parser.ts        # ✅ 已实现：流式解码 + 字节/字符 → 终端操作序列（print/cursor/control/sgr/osc…）
  ansi-parser.test.ts
  screen-buffer.ts      # ✅ 已实现：cell 网格 + 光标/换行/回滚 + SGR 状态 + 滚动上限裁剪
  screen-buffer.test.ts
  input-map.ts          # ✅ 已实现：按键事件 → 字节序列（char 直通 / line Ctrl 透传共用）
  input-map.test.ts
  input-line.ts         # ⬜ 设计中未落独立文件——line 模式直接用原生 <input> + useSendHistory，无需再抽
  term-size.ts          # ⬜ 设计中未落独立文件——行列由 TerminalPane.updateSize 内联计算（ResizeObserver + 字宽探针）
src/stores/terminal.ts       # ✅ 已实现 createTerminalStore：订阅 onData、流式解码、rAF 批处理、pause、回滚上限、CPR/DA 应答、RX hex 环形转储
src/stores/terminal.spec.ts
src/components/TerminalPane.vue    # ✅ 已实现：视口（RecycleScroller 固定行高 + 脏行补丁 + 块状光标）+ 工具栏（模式/echo/行尾/清空/复制/RX）
src/components/TerminalInput.vue   # ✅ 已实现：char/line 输入 + 历史 + echo 逻辑
```

### 关键模块说明

**AnsiParser**（[src/terminal/ansi-parser.ts](../src/terminal/ansi-parser.ts)，纯逻辑，有界状态）
- 输入：字节 → 内部 `TextDecoder(enc, { stream: true })` 流式解码（terminal store 持有 decoder 实例）→ 逐字符分类。
- 输出操作：`print(str)`、`cursor{op, params}`、`control{char}`、`osc(...)`（v1 忽略，仅吞掉）。
- 8-bit 控制、未知 CSI、参数越界一律忽略/容错，**永不 throw**；参数解析用 `\x1b[` + 数字参数 + 终止字节的有限状态机（≤4 个状态），防恶意长序列。
- v1 CSI 子集：光标寻址 `ESC[row;colH` / 列 `ESC[colG` / 上下左右移动 / 擦除 `ESC[J`(屏幕) `ESC[K`(行) / SGR 颜色属性 / 行列 wrap / 光标保存恢复 `s/u`/`7/8` / CPR/DA 查询。**defer**：alt-screen `?1049h/l`、滚动区域 `r`、插入/删除行列（IL/DL/ICH/DCH）（阶段三实现）。

**ScreenBuffer**（[src/terminal/screen-buffer.ts](../src/terminal/screen-buffer.ts)，纯逻辑，可单测）
- 结构：`rows × cols` 的 cell 网格（cell = `{ ch, fg, bg, bold }`）+ 光标 `(row, col)` + wrap 状态 + **回滚环形区**（视口之上的已完成行）。
- 语义：`\r` 回行首覆盖、`\n` 换行/到底滚动、`\b` 左移、`\t` 到下一 tab stop（8）、wrap 自动换行、SGR 累积到后续字符。
- 回滚上限（`scrollbackLimit`，默认 5000 行），超限裁最旧行并累计 `droppedLines`（复刻 `droppedFrames` 模式）。
- 提供 `viewportLines()`（含 dirty 标记，供增量渲染）、`consumeDirty()`（dirty 行号）、`getEpoch()`（trim/clear 后整表重建信号）、`lineToSegments`/`lineToText`（渲染/导出辅助）、`getText()`（复制/导出用，剥 SGR）。

**createTerminalStore**（[src/stores/terminal.ts](../src/stores/terminal.ts)，响应式编排）
- deps：`{ onData, sendRaw, paused, pauseStartTime, settings }`；接线在 `session/index.ts`（serial 之后）：`terminal = createTerminalStore({ onData: (cb) => serial.onData(cb), sendRaw: (bytes, record) => serial.sendRaw(bytes, record), paused, pauseStartTime, settings: s })`。
- 内部：`TextDecoder` 实例（连接建立时 lazy new）、`AnsiParser`、`ScreenBuffer`、rAF 批处理（每帧把到达批次 push 进 parser+buffer，只对 dirty/新增行做快照）、滚动裁剪计数、RX hex 环形转储（最近 400 字节）。
- 方法：`ingest(bytes)`、`injectLocal(bytes)`（本地回显，不受暂停控制）、`clear()`、`setSize(cols, rows)`、`scrollbackText()`、`sendBytes(bytes)`。CPR/DA 应答走注入的 `sendRaw`。

**TerminalPane**（[src/components/TerminalPane.vue](../src/components/TerminalPane.vue)，薄渲染）
- 虚拟滚动：**固定行高 RecycleScroller**（终端等宽字体行高恒定，勿用 DynamicScroller）。
- 脏行补丁：rAF 后仅对 dirty/新增行替换对象身份（`snapshotDeep`/`snapshotShared`），避免整表重建。
- 每行按 SGR 拆成 `<span>` 片段；**块状光标**：`.seg.cursor` 用 `display:inline-block; height/line-height: var(--term-line-height)` 撑满整行（inline span 背景只盖 em-box，会退化成偏上横线——这是已修的关键坑）。
- 工具栏：传输模式切换（char/line）、本地回显开关、行尾选择、暂停、清空、复制全部、RX hex 视图开关。
- 自动跟随滚动（`follow`，底部按钮 toggle）；`ResizeObserver` + 字宽探针计算行列并 `setSize`。
- **未实现**：导出文本按钮（`scrollbackText()` 已就绪）、暂停缺口标记线、字号/色彩设置页。

**TerminalInput**（[src/components/TerminalInput.vue](../src/components/TerminalInput.vue)，输入）
- `char` 模式：`keydown` → 按键字节立即 `sendRaw`；控制键按 D3 表映射；本地行缓冲不显示（等设备回显）；粘贴多行文本直接透传字节。
- `line` 模式：原生 `<input>` 本地编辑 + `useSendHistory`（↑/↓ 历史），Enter → `sendRaw(encode + lineEnding)`。
- 历史跨会话持久化（`useSendHistory` 已 localStorage 落盘）。
- 输入框位于 TerminalPane 底部一行（非 composer 的 textarea 多行语义）。

## UI 布局（ASCII 示意）

```
┌──────────────────────────────────────────────────────────────┐
│ ConnectionBar（端口/波特率/打开…）                              │
├──────────────────────────────────────────────────────────────┤
│  [消息 | 波形 | 终端]           ← 视图 tab，新增「终端」         │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐ │
│ │  root@board:~# ifconfig                 ← 回滚区（虚拟滚动）│ │
│ │  eth0: flags=4163<UP,BROADCAST,RUNNING> mtu 1500         │ │
│ │  root@board:~# ls                                       │ │
│ │  app   config   logs                                     │ │
│ │  root@board:~# █          ← 光标（块状，SGR 配色）         │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ [char▾|line] [echo] [行尾:CR] [暂停] [清空] [复制] [RX]    │ │  ← 工具栏
│ │ root@board:~# _              ← TerminalInput（单行）      │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ StatusBar（照旧）                                              │
└──────────────────────────────────────────────────────────────┘
```

## 设置项（`AppSettings.terminal`，已实现）

```ts
terminal: {
  cols: number            // 视口列数；0 = 跟随容器宽度（默认 0）
  rows: number            // 视口行数；0 = 跟随容器高度（默认 0）
  fontScale: number       // 字号缩放（相对全局 fontSize，默认 1）
  transmitMode: 'line' | 'char'   // 默认 'char'（嵌入式 Linux / Letter Shell）
  echo: boolean           // 本地回显，默认 false
  backspace: 'del' | 'bs' // 退格字节，默认 'del'(0x7F)
  lineEnding: LineEnding  // Enter 追加行尾，默认 'cr'（设计稿的 colorTheme 字段未落地，改用 lineEnding）
  scrollbackLimit: number // 回滚行上限，默认 5000
}
```

settings store 提供默认值并对旧配置浅合并兜底（缺字段补默认），`persistNow` 随全局设置自动落盘。

## 性能与稳定性护栏（沿用 production-gaps 硬教训，已实现）

1. **rAF 批处理摄入**：高频输出按帧合并处理，不逐字节触发 Vue 响应式（同 messages store 模式）。
2. **固定行高虚拟滚动**：RecycleScroller，视口内行数恒定；**禁止**对回滚区用 DynamicScroller（生产 gap 明确 O(n) 重算会渐进卡顿）。
3. **脏行增量补丁**：每 rAF 只对 dirty/新增行替换对象身份，未变行保留身份不重渲染。
4. **回滚上限 + 丢弃计数**：`scrollbackLimit` 硬裁剪，超限累加 `droppedLines`，TerminalPane 顶部提示条。
5. **解析器有界**：ANSI 状态机≤4 态、参数上限、畸形序列忽略不 throw；流式解码防多字节乱码且不重解码全缓冲。
6. **CPU 可降级**（未做）：可选设置「终端模式下暂停消息帧切分」（高频输出时省一份气泡开销），默认关闭（保持双写）。

## 边界与已知限制

- **全屏编辑器（vim/nano）需阶段三**：vim 重度依赖 alt-screen（DEC 1049）、光标保存/恢复、滚动区域 + SU/SD、插入/删除行列（IL/DL/ICH/DCH）、终端尺寸查询回复（见 D6）与括号粘贴。v1 不实现，vim 下以滚动文本呈现属已知局限；cell 网格 + 回复通道架构为阶段三一次性补齐预留。
- **resize 重排（reflow）**：容器尺寸变化时 v1 仅重设视口行列、按逻辑宽重新 wrap 顶部；不做历史行完整重排（复杂且收益低）。滚动内容以当时宽度存储。
- **GBK 键盘输入**：发送侧按 UTF-8（ASCII 兼容，中文输入边缘场景），显示侧 `TextDecoder('gbk', {stream:true})` 正常。
- **line 模式无本地 Ctrl+A/E/U/W readline 语义**：Ctrl 组合透传字节，避免与设备侧编辑冲突；需要本地编辑时用普通按键。
- **echo 检测不自动化**：双回显由用户手动关 echo 规避（默认关）；不做自动探测（误判风险高）。
- **导出无行级时间戳**：v1 导纯文本回滚（剥 ANSI）；行时间戳需在 screen-buffer 存首字节到达时刻，记 future。
- **终端内搜索**：v1 不做（ANSI 偏移与屏幕模型耦合复杂）；要检索切回「消息」tab 用现有搜索。
- **暂停缺口标记**（阶段二）：恢复时插一行 `── 已暂停 HH:MM:SS – HH:MM:SS ──`（复用 `formatTimestamp`），与消息/波形 toast 语义一致。

## 数据链路说明（Electron 路径）

本仓库当前为 **Electron** 桌面端：主进程 serialport 的 `'data'` 事件 → IPC `webContents.send` → preload → 渲染端 `SerialPortDriver.onData`，**原始字节逐字节直通，无任何插件层剥 `\r\n` / 丢空行的处理**，终端/消息收到与浏览器 Web Serial 一致的字节流，故无 archive 分支那种 Tauri 插件 `LineRouter` 剥行的根因问题。

> 若未来迁移 Tauri（`tauri-plugin-serialplugin` v3），需复现 archive 分支的 vendor 补丁：`route_watch_chunk` 原始字节直通、绕过 `LineRouter`（详见 archive 分支该文档的对应章节）。

## 实施计划

**阶段一（MVP）——✅ 已完成**
1. ✅ `src/terminal/ansi-parser.ts` + `screen-buffer.ts` + `input-map.ts` + 单测（流式解码、`\r/\n/\b/\t`、wrap、SGR、光标寻址子集、滚动、按键→字节）。
2. ✅ `createTerminalStore` + `session/index.ts` 接线（第七件套）+ `SessionPane` 新增 `terminal` 视图 tab。
3. ✅ `TerminalPane`（RecycleScroller + 脏行补丁 + 块状光标）+ `TerminalInput`（char 直通为主，line 模式一并落地）。
4. ✅ Mock 新增 `shell` 场景（回显 + 行编辑 + tab 补全 + ANSI 命令应答 + banner）。

**阶段二（体验完善）——部分完成**
5. ✅ line 模式本地编辑 + 历史、echo 开关、行尾/退格设置（TerminalInput 已实现；快速切换暂不落盘）。
6. ◐ 回滚上限 + dropped 提示条 ✅、复制全部 ✅、清空 ✅；**pause 缺口标记线 ⬜、导出文本按钮 ⬜**（`scrollbackText()` 已就绪，UI 未接）。
7. ⬜ 设置页「终端」（SettingsModal 新增页）+ `persistNow`；字号缩放已生效但设置入口未做。

**阶段三（进阶，可选）——含 vim/nano 全屏编辑器支持**
8. ⬜ **alt-screen + 全屏 TUI**：DEC 1049 备屏（进入/退出时主备屏互换、退出恢复主屏）、光标保存/恢复（ESC 7/8）、滚动区域（`ESC[<top>;<bot>r`）+ SU/SD、插入/删除行列（ICH/DCH/IL/DL）。落地即支持 vim/nano/htop 全屏编辑。
9. ⬜ **vim 交互细节**：CPR/DA/窗口尺寸应答完善（D6 已打底）、PageUp/PageDown/Home/End/F1-F12 键、bracketed paste（`ESC[?2004h`，粘贴多行文本时避免逐字符触发 vim 插入）、鼠标上报（`ESC[?1000h`，可选）。
10. ⬜ resize 重排、终端内搜索、行级时间戳导出。

## 待用户确认决策（已定/未决）

1. ~~**D2 范围**~~：✅ 已定——直接做 cell 网格（一次到位），行流渲染弃用。
2. ~~**D3 默认模式**~~：✅ 已定——char 直通为默认（面向嵌入式 Linux / Letter Shell 主场景）。
3. ~~**echo 默认关**~~：✅ 已定（默认关，靠设备回显）；「连接后自动弹提示引导首次用户」未做，可后续考虑。
4. ~~**回滚上限默认值**~~：✅ 已定 5000 行。
5. ~~**终端是否默认可见**~~：✅ 已定——视图 tab 默认停在「消息」，首次进入不引导。
6. **双写策略**：◐ 保留消息帧切分并行采集（可切回搜索）；「终端模式暂停帧切分」省 CPU 开关未做（护栏第 6 条）。
