# 终端模式（Terminal Mode）设计 —— xterm.js 版

> **注：** 终端渲染与 ANSI/VT 解析采用 **xterm.js**（`@xterm/xterm` + `@xterm/addon-fit`，VS Code 终端同款），替换此前自研的 cell 网格 buffer + ANSI 解析器。xterm 内置完整终端能力：cell 网格缓冲、光标、SGR/256 色/真彩、回滚、alt-screen（DEC 1049）、滚动区域 + SU/SD、插入/删除行列（ICH/DCH/IL/DL）、CPR/DA/窗口尺寸应答、括号粘贴、鼠标上报——**vim/nano 全屏编辑直接可用**。
>
> 本文件是终端模式的架构说明 + 实施蓝图，行文以已实现代码为准。
> 日期：2026-08-08。状态：**xterm.js 迁移中**（见「实施计划」里程碑）。
>
> 关联：`docs/production-gaps.md`；迁移前自研实现见 git 历史（`feat/terminal` 提交，本分支已替换）。

## 背景与目标

现有串口助手是**帧气泡**模型：RX 按帧切分策略切成气泡，发送用 textarea 拼行。这个模型适合「发指令收数据」，但**不适用交互式 shell**：

- 嵌入式 Linux 串口 console（busybox ash / bash + readline）——设备侧行编辑 + **回显**，输出是连续字节流（prompt、彩色命令输出、`\r` 重绘、tab 补全重画整行）；
- Letter Shell（MCU 交互式 shell，设备侧行编辑 + 回显）——同上。

这类设备的正确交互模型是**物理终端**：按键即时下发、设备回显、屏幕按终端语义重绘。目标是为串口助手新增**终端视图**，直接连嵌入式 Linux 串口 / Letter Shell 交互调试，同时**保留**气泡/波形/录制能力（终端与气泡并行采集）。

## 为什么选 xterm.js

- **协议完备且久经考验**：自研解析器只做 v1 CSI 子集，vim/nano 所需的 alt-screen、滚动区域、插入/删除行列、CPR/DA 窗口尺寸应答、括号粘贴、鼠标上报等全部缺失——手写补齐工程量大致等于重写一个终端模拟器。xterm.js 全部内置且被 VS Code / Jupyter / Codespaces 生产验证。
- **渲染性能**：Canvas/WebGL 渲染器自带增量重绘与脏行优化，高于自研「RecycleScroller + 脏行补丁」方案，且天然处理超大回滚。
- **回滚与选区**：`scrollback` 上限、鼠标/键盘选区、右键复制都是内置能力。
- **输入模型**：xterm 是**哑终端**——用户按键经内部解析后通过 `onData` 输出字节串（方向键 `ESC[A`、Ctrl+C `\x03`、Enter `\r`…），正好覆盖我们 char 直通模式的按键→字节映射，`input-map.ts` 不再需要自维护转义表。

**代价（诚实列出）：**
- **bundle 体积**：xterm + fit 约 +1MB（当前构建产物已 ~1MB，桌面端可接受，浏览器端首屏变重）。
- **droppedLines 计数变近似**：xterm 回滚是静默裁剪，无「丢弃 N 行」事件；用「已写入行数 − 容量」近似，非精确。
- **GBK 解码**：xterm 只原生处理 UTF-8；GBK 需我们流式 `TextDecoder('gbk', {stream:true})` 解码后再 `term.write`。

## 目标与场景

| 场景 | 目标 |
| --- | --- |
| 嵌入式 Linux 串口 console（设备回显 + 行编辑） | 按键直通、视口正确重绘、tab 补全/`\r` 重绘/ANSI 色彩正常（xterm 原生） |
| Letter Shell（MCU 交互式 shell） | 同上，且兼容性/容错比自研更全 |
| vim / nano / htop 全屏程序 | **直接可用**（alt-screen 等由 xterm 内置，里程碑 M2 验证） |
| 不回显的裸设备 / AT 命令 | line 模式 + 本地回显兜底（应用层） |

## 现状（已核实）

- `Session`（[src/session/index.ts](../src/session/index.ts)）装配 store **七件套**（含 `terminal`）；`SessionPane.mainView` 为 `'messages' | 'waveform' | 'terminal'`。
- `serial store` 暴露 `onData(cb)`（帧切分前原始字节）与 `onTxData(cb)`；`serial.sendRaw(bytes, record)` 裸写不追加校验和/行尾。终端 store 经 `onData` 订阅、发送走 `sendRaw(record=false)`。
- `AppSettings.terminal`（[src/types.ts](../src/types.ts)）：`cols/rows/fontScale/transmitMode/echo/backspace/lineEnding/scrollbackLimit`，settings store 提供默认值 + 浅合并兜底。
- Mock 已新增 `shell` 场景（`MockShell`：回显 + 行编辑 + tab 补全 + ANSI 命令应答），无硬件自测可用。

## 关键决策

### D1：终端是「会话内第三视图」

`SessionPane.mainView` 含 `terminal`，选中渲染 `TerminalPane`，隐藏 `MessageList + InputComposer`。终端数据后台持续采集，切回消息 tab 可看帧日志/搜索/导出。**保持。**

### D2：渲染与 ANSI 解析交给 xterm.js

`TerminalPane` 挂载一个 xterm 实例（`term.open(el)` + FitAddon），自研 `ansi-parser.ts` / `screen-buffer.ts` 删除。终端 store 只做**薄桥**：字节 → 流式解码 → `term.write`；`term.onData` → 字节下发。xterm 内部负责 cell 网格、光标、SGR、回滚、alt-screen 等全部渲染语义。

### D3：输入行规（应用层保留）

xterm 是哑终端，**char/line 双模式 + 本地回显是应用层交互模型，由我们在 xterm 之上实现**：

| 传输模式 | 编辑方 | 发送时机 | 适配对象 |
| --- | --- | --- | --- |
| **字符直通 `char`**（默认） | 设备侧 | 按键经 xterm `onData` 即时下发 | 嵌入式 Linux console / Letter Shell |
| **行发送 `line`** | 本地（原生 `<input>` + 历史） | Enter 发送 `行 + 行尾` | 不回显裸设备 / AT 命令 |

- **char 模式**：xterm 自带输入焦点，按键 → `onData(data)` → 我们映射 `\r`→所选行尾、`\x7f`→`0x08`（若 backspace=bs）→ `sendRaw`。本地回显 ON 时同时 `term.write(data)`。
- **line 模式**：渲染一个原生 `<input>`（复用 `useSendHistory` 历史），Enter → `sendRaw(encode(line)+行尾)`；echo ON 时 `term.write(line+行尾)`。Ctrl 组合（Ctrl+C 等）透传控制字节。
- **echo 默认关**：目标设备均自身回显，开则双显。不回显设备手动开。

### D4：TX 在终端视图无气泡

所有路径 `sendRaw(record=false)`：不污染 messages 帧日志；recorder 经 `onTxData` 照常录制。**保持。**

### D5：设置与会话

- `AppSettings.terminal` 直接映射 xterm 选项：`scrollbackLimit`→`scrollback`、`fontScale×fontSize`→`fontSize`；设置变更经 `term.options` 热更新。
- `transmitMode/echo/lineEnding/backspace` 为会话内视图态（TerminalPane 工具栏快速切换，暂不落盘——SettingsModal 页待做）。
- 终端 store 尊重全局 pause：暂停停止 `term.write`。

### D6：设备查询应答 → xterm 原生

xterm 内部自动处理 CPR（`ESC[6n`）、DA（`ESC[c`/`ESC[>c`）、窗口尺寸（`ESC[18t`）并回写应答，**无需自研应答通道**。`stty size`、vim 的终端协商天然可用。

## 架构与数据流

```
  SerialDriver.onData（原始字节）
        │
        ├──▶ messages store（FrameSplitter → 帧气泡）   [照旧]
        ├──▶ waveform store（onData 订阅）              [照旧]
        └──▶ terminal store（xterm 薄桥）[本分支迁移]
                ├── TextDecoder(enc,{stream:true}) 流式解码
                ├── term.write(text)  ──▶  xterm（cell 网格/SGR/回滚/alt-screen…）
                ├── rawDump（最近 400 字节 hex，调试视图）
                └── droppedLines（近似计数）

  xterm onData（char 模式用户按键）[xterm 生成转义序列]
        └──▶ terminal store：映射行尾/退格 → sendRaw(bytes, record=false)
                    └──▶ driver.write ──▶ onTxData ──▶ recorder（照旧录制）

  TerminalInput（line 模式本地编辑 + 历史）[应用层]
        └──▶ sendRaw(encode(line)+行尾)；echo ON 时 term.write(line+行尾)
```

## 关键模块说明

**terminal store**（[src/stores/terminal.ts](../src/stores/terminal.ts)，xterm 薄桥）
- deps：`{ onData, sendRaw, paused, pauseStartTime, settings }`；接线在 `session/index.ts`。
- 持有 `Terminal` 实例（xterm 核心无 DOM 依赖，可 headless 建；`open()` 才需 DOM，由组件调用）。
- `ingest(bytes)`：暂停则跳过；`TextDecoder(enc,{stream:true})` 流式解码 → `term.write(text)`；更新 rawDump 环与 droppedLines 近似。
- 输入通道：`term.onData(data)` → `if mode!=='char' return`；`\r`→`lineEndingBytes(lineEnding)`、`\x7f`+backspace=bs→`0x08`；echo ON 先 `term.write(data)`；`sendBytes(record=false)`。
- 方法：`sendBytes`、`echoText(text)`（line 模式本地回显）、`clear()`（写 `ESC[2J ESC[3J ESC[H` 清屏+清回滚）、`scrollbackText()`（遍历 `term.buffer.active` 取全量文本，复制/导出用）、`setSize(cols,rows)`、`ingest`。
- 会话态（组件读写）：`mode/echo/lineEnding/backspace` refs；`term` 暴露给组件 `open`。
- 生命周期：`onScopeDispose` → `unsubscribe()` + `term.dispose()`。

**TerminalPane**（[src/components/TerminalPane.vue](../src/components/TerminalPane.vue)）
- `onMounted`：`term.open(host)`、`loadAddon(FitAddon)`、首 `fit()`；`ResizeObserver` 驱动 `fit()`（容器 resize / 视图从隐藏切回可见时）。
- 跟随滚动：`term.onScroll` 更新 `follow`（`viewportY >= baseY` 即在底部）；不在底部显示「回到最新」→ `term.scrollToBottom()`。
- 工具栏（照旧）：char/line 切换、echo、行尾、暂停、清空、复制全部、RX hex 视图。
- char 模式显示提示条（「直通模式：按键即发送，由设备回显」），line 模式渲染 `TerminalInput`。

**TerminalInput**（[src/components/TerminalInput.vue](../src/components/TerminalInput.vue)，仅 line 模式）
- 原生 `<input>` + `useSendHistory`（↑/↓ 历史）；Enter → 发送 + 清空；Ctrl+字母 → 控制字节透传（Ctrl+C/Z/D）；Backspace/方向键本地编辑。
- echo ON：发送后 `terminal.echoText(line+行尾)`。

**删除**：`src/terminal/ansi-parser.ts`、`screen-buffer.ts`、`input-map.ts` 及对应测试（逻辑归 xterm）。

## 设置项（`AppSettings.terminal`）

```ts
terminal: {
  cols: number            // 视口列数；0 = 跟随容器宽度（FitAddon，默认 0）
  rows: number            // 视口行数；0 = 跟随容器高度（默认 0）
  fontScale: number       // 字号缩放（相对全局 fontSize，默认 1）→ xterm options.fontSize
  transmitMode: 'line' | 'char'   // 默认 'char'
  echo: boolean           // 本地回显，默认 false
  backspace: 'del' | 'bs' // 退格字节，默认 'del'(0x7F)
  lineEnding: LineEnding  // Enter 追加行尾，默认 'cr'
  scrollbackLimit: number // 回滚行上限 → xterm options.scrollback，默认 5000
}
```

## 边界与已知限制

- **droppedLines 为近似值**：xterm 静默裁剪回滚，无精确丢弃计数；用写入行数近似，仅作提示。
- **GBK**：显示侧流式 `TextDecoder('gbk',{stream:true})` 正常；发送侧按 UTF-8（ASCII 兼容，中文输入边缘场景）。
- **line 模式无本地 readline（Ctrl+A/E/U/W）**：Ctrl 组合透传字节，避免与设备侧编辑冲突。
- **echo 不自动探测**：双回显手动关 echo 规避（默认关）。
- **导出无行级时间戳**：v1 导纯文本（`scrollbackText()`）；行时间戳记 future。
- **终端内搜索**：v1 不做；要检索切回「消息」tab。
- **暂停缺口标记**：恢复时插一行 `── 已暂停 HH:MM:SS – HH:MM:SS ──`（复用 `formatTimestamp`），与消息/波形 toast 语义一致。

## 数据链路说明（Electron 路径）

本仓库为 **Electron** 桌面端：主进程 serialport `'data'` 事件 → IPC → preload → 渲染端 `SerialPortDriver.onData`，**原始字节逐字节直通**，无插件层剥 `\r\n`/丢空行问题（archive 分支 Tauri 插件 `LineRouter` 的坑不存在）。若未来迁移 Tauri，需复现 archive 分支的 vendor 补丁（`route_watch_chunk` 原始字节直通）。

## 实施计划

**M1（当前分支）——xterm.js 迁移：替换自研渲染为 xterm 薄桥**
- ✅ 安装 `@xterm/xterm` + `@xterm/addon-fit`；`main.ts` 引入 `xterm.css`
- ✅ terminal store 重写为薄桥（`term.write`/`onData`/暂停/rawDump/回滚近似）
- ✅ TerminalPane 挂载 xterm + FitAddon + 工具栏；TerminalInput 收敛为 line 模式
- ✅ 删除 `src/terminal/` 自研解析/buffer/input-map 及测试；重写 `terminal.spec.ts`、更新 session 集成测试
- ⬜ 首次打开/隐藏切回时 fit 与焦点、bundle 体积核对

**M2 —— 全屏 TUI 验证（vim 目标）**
- 用 mock shell 场景验证 vim/nano/htop 全屏渲染：alt-screen、光标保存恢复、滚动区域、CPR/DA/窗口尺寸应答（xterm 内置）
- mock 增补全屏程序自测场景（如 vim 打开/退出/滚动/编辑），无硬件复现
- 括号粘贴（`ESC[?2004h`）：粘贴多行文本避免逐字符触发 vim 插入（xterm 默认支持，验证透传）

**M3 —— 体验完善**
- SettingsModal「终端」页：字号缩放、回滚上限、行尾/退格/模式默认值 + `persistNow`
- 暂停缺口标记、导出文本按钮（`scrollbackText()` 已就绪）
- 主题映射：`AppSettings.themeId` → xterm `options.theme`（亮/暗调色板）
- line 模式本地 readline 快捷键（可选）

## 待确认决策

1. ~~渲染方案~~：✅ 已定——xterm.js，弃自研 buffer/解析器。
2. ~~默认模式~~：✅ 已定——char 直通为默认。
3. ~~echo 默认关~~：✅ 已定。
4. ~~回滚上限~~：✅ 默认 5000。
5. ~~终端默认可见~~：✅ tab 默认停在「消息」。
6. **双写策略**：◐ 保留消息帧切分并行采集；「终端模式暂停帧切分」省 CPU 开关未做。
7. **droppedLines 近似**：接受 xterm 静默回滚 + 近似计数，还是移除该提示（求更简洁 UI）？
