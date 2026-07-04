# 波形图功能设计文档

> 基于 uPlot 的串口字节流波形可视化。本文档为实现前的正式设计，随代码一同提交。

## 1. 背景与目标

当前 serial-demo 只能以 ASCII / HEX 文本查看串口字节，缺少"把字节解析为数值并画成波形"的能力。
嵌入式调试中常见的需求是：MCU 持续上报 ADC 采样、传感器读数等二进制数值流，调试者希望实时看到这些数值随时间变化的曲线。

本功能的目标：

1. 在主区域通过 `[消息] / [波形]` 标签切换，新增一个波形视图。
2. 用 **uPlot** 渲染（专为高频时序数据设计，Canvas 实现，自带类型声明）。
3. 新增一个产生结构化二进制采样的模拟场景，使波形可演示。
4. 提供一个**可配置的数值解析器**（数值类型 / 大小端 / 通道数 / 字节偏移，持久化到设置），
   阶段 2 接真实串口时复用同一套解析配置，无需改代码。

## 2. 数据流

```
SerialDriver.onData(bytes)
        │
        ▼
serial store connect() 内的 driver.onData 回调
        │
        ├─► messages.ingestRx(bytes)        （原有：帧切分 → 消息列表）
        │
        └─► externalDataListeners fan-out   （新增）
                │
                ▼
        waveform store.ingest(bytes)
                │
                ▼
        byte-parser.parseSamples(bytes, cfg, carryover)
          ├─ 把 carryover 拼到 bytes 前
          ├─ 按 recordSize = byteOffset + channels*bytesPerSample 切 record
          ├─ 用 DataView 读出每通道数值（uint8/int16/float32 …, LE/BE）
          └─ 零头作为新 remainder 返回（跨回调承接半截采样）
                │
                ▼
        按通道 append 进历史缓冲 history[ch][]
          X = startTime + sampleIndex++ * (1000/sampleRate)
          超 MAX_HISTORY 从头裁剪；可视窗口 data = history 末尾 maxPoints 切片
                │
                ▼
        WaveformChart 组件 watch(version) + rAF 节流 → uPlot.setData(data)
```

**关键原则**：波形管线订阅**原始字节**（在 messages store 的帧切分之前），独立解析，
与消息列表互不干扰。同一份字节流被两个独立消费者处理。

## 3. 关键设计决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 面板位置 | `.left` 顶部 `[消息]/[波形]` 标签切换，`InputComposer` 留底部 | 波形需要宽度；发送框在两个视图都常用 |
| 数据接入点 | serial store 新增 `onData(cb)` fan-out | 解耦；波形 store 不依赖 messages store 的帧切分 |
| 解析模型 | sample-level（每 N 字节 = 一组多通道采样） | 适配连续 ADC 流；carryover 承接半截采样 |
| 时间轴 | 全局采样计数器 × `1000/sampleRate` | 平滑无抖动，不受批次到达抖动影响 |
| 主题 | uPlot 颜色 JS 读 tokens.css 的 CSS 变量，`watch(isDark)` 销毁重建 | uPlot 不吃 CSS 变量；重建简单可靠且低频 |
| 默认配置 | int16 LE、2 通道、sampleRate 640、maxPoints 5000 | 匹配模拟场景；5000 点 uPlot 轻松渲染 |
| 隐藏 tab 尺寸 | `v-show` + ResizeObserver，0 尺寸跳过 setSize | 切回波形标签时 RO 自动触发 setSize |

## 4. 文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/utils/byte-parser.ts` | 纯函数数值解析（DataView，含大小端/有无符号/浮点），无 Vue 依赖，可单测 |
| `src/utils/byte-parser.spec.ts` | 解析器单测：uint8 / int16 LE·BE / float32 / 多通道交错 / carryover |
| `src/stores/waveform.ts` | Pinia store：环形滑动窗口 + 串口字节订阅 + 解析调度 |
| `src/components/WaveformChart.vue` | uPlot 封装组件（生命周期 / 主题 / 自适应 / 清空暂停） |
| `src/composables/useIsDark.ts` | 抽取 isDark 逻辑（settings.theme + matchMedia），App.vue 与 WaveformChart 共用 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 加 `NumericType`、`WaveformParseConfig`；`AppSettings.waveform`；`MockScenarioId` 加 `'waveform'` |
| `src/stores/settings.ts` | `DEFAULTS.waveform` 默认值 |
| `src/mock/scenarios.ts` | `waveformChunk(seq)` 生成器 + `SCENARIOS` 条目 |
| `src/mock/MockSerialSource.ts` | 场景 switch 加 `case 'waveform'`（每 50ms 一帧 128 字节） |
| `src/stores/serial.ts` | `externalDataListeners` Set + `onData(cb)` + connect 内 fan-out + disconnect 清空 |
| `src/App.vue` | `mainView` 状态 + 标签条 + `v-show` 切换；用 `useIsDark` |
| `src/components/SettingsDrawer.vue` | 「波形」设置分组（类型/大小端/通道数/偏移/采样率/最大点数） |

> ConnectionBar 无需改动——场景选择器读 `SCENARIOS` 数组，加条目即自动出现。

## 5. 解析器契约

```ts
type NumericType = 'uint8'|'int8'|'uint16'|'int16'|'uint32'|'int32'|'float32'|'float64'

interface WaveformParseConfig {
  type: NumericType
  littleEndian: boolean
  channels: number      // 交错通道数
  byteOffset: number    // 每 record 起始跳过的字节数（如帧头）
}

// recordSize = byteOffset + channels * bytesPerSample(type)
// 返回 perChannel[ch] = number[]（本批新增的采样），remainder = 不足一个 record 的零头
parseSamples(bytes, cfg, carryover): { perChannel: number[][]; remainder: Uint8Array }
```

## 6. 模拟场景

`waveformChunk(seq)`：每帧 32 采样 × 2 通道 × int16 LE = 128 字节。

故意加入慢变调制 + 噪声，使信号非纯周期：滑动窗口滚满后，新进数据与滚出数据不再逐周期重复，波形持续可见变化（更像真实传感器：慢漂移 + 周期信号 + 白噪声）。

- `ch0 = round(sin(2π·2·t) · env + 噪声 ±400)`，`env = 16000 + 6000·sin(2π·0.1·t)`（2 Hz 正弦被 0.1Hz 慢变包络调制，幅度 10000–22000）
- `ch1 = round(sin(2π·5·t) · 12000 + drift + 噪声 ±800)`，`drift = 4000·sin(2π·0.07·t)`（5 Hz 正弦 + 0.07Hz 慢变直流偏置 ±4000）
- `t = (seq*32 + i) / 640`，每 50ms 发一帧 → 640 采样/秒，与默认 `sampleRate: 640` 匹配，X 轴为真实时间。
- 所有幅度 ≤ ±22000，int16 安全（±32767）。

## 7. uPlot 集成要点

- `data` 形状：`number[][]`，`data[0]` = X 时间戳，`data[1..channels]` = 各通道 Y。
- `onMounted`：读 CSS 变量构造 opts（grid/axes/series 颜色 + series 标签 `CH1/CH2…`），`new uPlot(opts, data, el)`。
- `ResizeObserver` → `chart.setSize({width,height})`（0 尺寸跳过）。
- `watch(data)` + rAF 节流 → `chart.setData(data)`。
- `watch(isDark)` → `chart.destroy()` 后重建（应用主题色）。
- `onBeforeUnmount` → `chart.destroy()` + RO.disconnect。
- `cursor.drag = { setScale: false, x: false, y: false }` 关闭 uPlot 默认拖框放大（避免误操作）。
- 暂停时于 `chart.over` 覆盖层挂 `pointerdown/move/up` 实现 grab 式平移回看历史（见 §10）。

## 8. 验证

1. `npm run typecheck` —— 唯一质量门禁，必须通过。
2. `npm test` —— `byte-parser.spec.ts` + `waveform.spec.ts` 全绿。
3. `npm run dev` —— 选「波形」场景 → 连接 → 切 `[波形]` 标签 → 双通道正弦波实时滚动；
   改通道数/大小端/采样率/最大点数，波形随之变化；切暗色主题配色跟随；拖拽窗口 uPlot 自适应；
   点清空缓冲重置。
4. **滚满验证**：窗口滚到 maxPoints 后波形仍持续滚动、点数稳定在 maxPoints
   （刷新信号用 `version` 版本号而非数组长度，避免窗口满后卡死）。
5. **历史回看验证**：等数据滚满 → 暂停 → 向右拖拽应 1:1 平移回看更早波形、工具栏出现「回看 −Xs」与「回到最新」；
   点「回到最新」或恢复运行即回实时；运行中拖拽不再框选放大。

## 9. 单片机数据协议

阶段 2 接真实串口时，单片机只需按一个固定的字节布局连续发送数据，波形图即可正确解析。
本节为对接协议参考，**改设置面板匹配单片机即可，解析代码不动**。

### 9.1 默认配置下的字节布局

默认配置：`int16 小端、2 通道、byteOffset=0`。
`recordSize = 0 + 2×2 = 4 字节`，每 4 字节为一组多通道采样，通道**交错**排列：

```
偏移  0   1   2   3   4   5   6   7   8   9  10  11 ...
     [采样0 ch0 ][采样0 ch1 ][采样1 ch0 ][采样1 ch1 ]...
       低 高   低 高   低 高   低 高
       ←int16→ ←int16→ ←int16→ ←int16→
```

- **int16 小端**：低字节在前、高字节在后。STM32（ARM 小端）的 `int16_t` 在内存里天然就是此顺序，直接发内存即可，无需手动拼字节。
- **通道交错**：同一时刻各通道紧挨着，然后才是下一时刻——这是 ADC 多通道 DMA 的标准排布。

### 9.2 STM32 发送示例

```c
// 一组多通道采样（与解析器 record 结构对应）
typedef struct {
    int16_t ch0;   // 通道0，如 ADC1
    int16_t ch1;   // 通道1，如 ADC2
} __attribute__((packed)) sample_t;

// DMA 双通道交替模式会自动交错填入此缓冲
static sample_t buf[32];

// 半转换完成中断：发前 16 组采样
void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc) {
    HAL_UART_Transmit_DMA(&huart1, (uint8_t*)&buf[0], 16 * sizeof(sample_t));
}
```

直接把 `sample_t` 数组内存丢给 UART/DMA——小端 + 交错正是默认配置要的格式。

### 9.3 四个关键认知

1. **字节序天然匹配**。STM32 小端，`int16_t` 内存里即低字节在前，与默认 LE 一致。大端 MCU（少见）把设置里「字节序」改大端即可，代码不动。
2. **分包不必对齐 record 边界**。解析器带 carryover，跨包的半截采样留到下次拼接。DMA 一次发 40 或 73 字节都行，不必是 4 的倍数；UART 的粘包/拆包也无所谓。
3. **采样率只是 X 轴标尺，不影响能否解析**。解析只看字节结构（类型/通道/偏移），完全不读采样率。`sampleRate` 仅决定 X 轴时间刻度——波形一定画得出，但要 X 轴显示真实时间，得把它设成单片机实际采样率（如 ADC 配 1kHz 填 1000）。
4. **发送节奏不影响波形形状**。X 轴按「采样点序号 × (1000/sampleRate)」推进，不按字节真实到达时间。1ms 突发 100 点与匀速发 100 点画出的时间跨度一样——这是「平滑无抖动」的设计取舍。

### 9.4 适配其他格式

单片机数据非默认格式时，改设置面板匹配，代码不动：

| 单片机情况 | 设置改动 |
|---|---|
| 单通道采样 | 通道数 → 1 |
| 每帧带帧头（如 `AA 55`） | byteOffset → 2（跳过帧头） |
| float 传感器数据 | 类型 → float32（4 字节/采样） |
| 4 通道 ADC | 通道数 → 4 |
| 大端 MCU | 字节序 → 大端 |

解析逻辑全部参数化且配置持久化——这是这套抽象的意义：阶段 2 换真实驱动时，单片机协议和解析配置都无需改代码。

## 10. 历史回看（暂停后拖拽平移）

### 10.1 动机

早期实现是单一滑动窗口：`trimIfNeeded` 把超过 `maxPoints` 的旧采样**从头丢弃**。这带来两个问题：

1. uPlot 默认 `cursor.drag.setScale: true`，在图上拖拽会**框选放大**该区域——调试时极易误触。
2. 旧数据被即时删除，**没有历史可回看**——暂停后想看几秒前的波形已不可能。

### 10.2 两层模型：历史缓冲 + 可视窗口

把「保留多少数据」与「显示哪一段」解耦：

| 层 | 含义 | 上限 |
|---|---|---|
| `history` | 完整保留的采样缓冲（`[X, ch1, ch2, …]`），组件**不直接渲染** | 常量 `MAX_HISTORY = 200_000`（~5min@640Hz、2 通道约 3MB），从头裁剪 |
| `data` | 可视切片 = `history` 末尾向前偏移 `viewOffset` 个采样的 `maxPoints` 长度窗口 | `maxPoints`（现为「可视点数」） |
| `viewOffset` | 从尾部向回偏移的采样数。`0` = 跟随最新；`>0` = 回看更早 | `[0, history长度 − viewSize]`，由 `recomputeView` clamp |

- 组件照旧 `chart.setData(waveform.data)`——`data` 永远是当前可视切片，x 轴 auto-fit 即正确显示该窗口。
- 运行中（`!paused`）`viewOffset` 恒为 `0`，数据流入时可视窗口自动跟随最新（观感同旧）。
- 暂停后拖拽调整 `viewOffset` 回看；`togglePause` 恢复时归零自动回到最新。

### 10.3 交互

- **关闭默认放大**：`cursor.drag = { setScale: false, x: false, y: false }`，运行中拖拽置空（既不放大也不平移）。
- **暂停时 grab-pan**：于 `chart.over` 挂 `pointerdown/move/up`，`setPointerCapture` 锁定。
  - `samplesPerPx = viewSize / chart.over.clientWidth`；`target = startOffset + round(dx × samplesPerPx)`。
  - **方向**：向右拖（`dx>0`）→ `viewOffset` 增大 → 看更早历史（grab 隐喻：抓住波形向右拉，左侧更早内容进入视野，1:1 跟手）。
  - 仅 `paused` 时 `onPanDown` 才启动；光标 `grab`/`grabbing`。
- **回到最新**：工具栏在 `viewOffset > 0` 时显示「回到最新」按钮（`resetView`）与「回看 −Xs」提示；恢复运行也自动回最新。

### 10.4 配置变更语义（相对旧版的调整）

- 采样率变更：重算**全部 history** 的 X（不只可视窗口，否则回看时时间轴会错）。
- `maxPoints` 变更：现为「可视点数」→ 仅 `recomputeView` 重切窗口，**不再裁剪 history**。
- 解析配置变更：仍清空重建（history 与 data 一并重置）。

### 10.5 取舍

- 历史上限用常量 `MAX_HISTORY = 200_000`（不做设置项）：避免长会话无界内存增长；`maxPoints` 设置上限 100k，恒 ≤ 此值，回看总有余量。后续可按需提升为设置。
- pan 仅暂停时启用（符合「当点击暂停时」）；恢复自动回最新，避免停留在历史里错过新数据。
- y 轴随可视窗口 auto-fit（沿用 `setData` 默认 `resetScales`），回看到不同幅度区域时 y 自适应（类示波器 auto-y）。
- uPlot 1.6 无内置 pan 插件，自实现 grab-pan 更可控且零依赖。

## 11. 滚轮缩放（时基缩放）

### 11.1 动机

窗口滚满后，`maxPoints` 个采样挤满绘图区，波形密集、细节难辨。嵌入式调试常需"放大看某段细节"——
如检查一个边沿、一个毛刺、半个周期。需要滚轮缩放，且**放大必须露出真实细节**：若只是把同样的点
拉伸开，放大后仍是折线、无新信息。因此缩放语义是**改变可视窗口跨度**，从 history 取更少但更密集的真实采样。

### 11.2 窗口几何：位置 + 跨度

回看模型只有 `viewOffset`（窗口位置）。缩放再加一个正交维度 `viewSize`（窗口跨度）：

| 量 | 含义 | 默认 | 改动方式 |
|---|---|---|---|
| `viewOffset` | 窗口右边缘距 history 尾部的偏移（位置） | `0`（跟随最新） | 暂停时拖拽 |
| `viewSize` | 可视窗口采样数（跨度） | `maxPoints` | 滚轮缩放 |
| `zoomed` | 是否处于缩放态（viewSize 独立于 maxPoints） | `false` | 缩放时置 true；回到 maxPoints 置 false |

可视窗口 = `history[histLen − viewOffset − viewSize, histLen − viewOffset)`。`viewOffset` 管位置、
`viewSize` 管跨度，二者正交，共同定义窗口几何。`recomputeView` 用 `viewSize`（clamp 到
`[MIN_VIEW, maxPoints]`）切片，x 轴 auto-fit 即正确显示当前跨度。

### 11.3 锚定策略：运行中锚最新，暂停时锚光标

| 状态 | 锚点 | 行为 |
|---|---|---|
| 运行中（`!paused`） | 右边缘（最新） | 只改 `viewSize`，`viewOffset` 恒 0；数据流入仍跟随最新（时基缩放，不与自动跟随冲突） |
| 暂停（`paused`） | 光标位置 | 光标下采样保持在同分数位置，同时调 `viewSize` 与 `viewOffset`，放大目标不跑偏 |

**为什么运行中也允许缩放**：示波器 RUN 模式可调时基，是实时看细节的刚需。缩放只改跨度、不动位置，
不与自动跟随冲突（pan 才冲突，故 pan 仍仅暂停可用）。运行中锚定最新而非光标，因为数据在滚、
光标下的采样瞬息万变，锚光标无意义。

**光标锚定数学**：设光标在绘图区分数 `f`（0=左、1=右），旧窗口右边缘 `oldEnd = histLen − viewOffset`，
锚点采样 `anchorIdx = oldEnd − (1−f)·oldSize`。放大后令锚点仍处于分数 `f`：
`newEnd = anchorIdx + (1−f)·newSize`，`viewOffset = round(histLen − newEnd)`，再 clamp 到
`[0, histLen − newSize]`。整数采样网格下分数位置非精确保持，但锚点采样恒留在新窗口内（不跑偏）。

### 11.4 缩放因子与范围

- `factor = exp(δy · 0.0018)`：wheel up（`δy<0`）→ `factor<1` → 放大。`exp` 使鼠标 notch（δy≈±100，
  ≈1.2×/格）与触控板小 δy 平滑统一。
- 范围 `[MIN_VIEW=2, maxPoints]`：放大最深约 2 采样；缩小至 `maxPoints` 即回到默认窗口（`zoomed=false`）。
  上限不超 `maxPoints` 以保证渲染负载受控（不悄悄渲染到 200k）。`MIN_VIEW` 为常量，可按需调大（如 10）。
- 非被动 wheel 监听 + `preventDefault`：阻止页面滚动，也接管浏览器 ctrl+wheel 页面缩放与触控板捏合（捏合
  在浏览器里即 ctrl+wheel，同样被接管为波形缩放）。

### 11.5 与 pan / 配置的联动

- **pan 1:1 跟手**：`onPanMove` 的 `samplesPerPx` 改用 `viewSize`（原为 `maxPoints`）。否则缩放后拖拽会快
  N 倍、不再 1:1。缩放与 pan 正交（滚轮 vs 拖拽），暂停时可先缩放再平移。
- **maxPoints 变更**：`!zoomed` → `viewSize` 跟随新 `maxPoints`（默认窗口随之变）；`zoomed` → 仅 clamp 到
  新 `[MIN_VIEW, maxPoints]`（保持用户倍率）。用 `zoomed` 标志区分"未缩放、跟随默认"与"缩放中、保持倍率"。
- **恢复运行 / clear**：`togglePause` 恢复时 `viewOffset` 归零、`viewSize` 保留（保留缩放倍率）；`clear` 一并
  重置缩放（`zoomed=false`、`viewSize=maxPoints`）。
- **工具栏**：`zoomed` 时显示「放大 ×N」（`N = maxPoints/viewSize`）与「重置缩放」按钮，与「回看 −Xs」、
  「回到最新」并列。

### 11.6 取舍

- 缩放范围上限 = `maxPoints`（非 history 全长）：保证渲染负载受 maxPoints 设置约束；要看更大范围调大 maxPoints。
- 运行中锚定最新而非光标：数据滚动时光标锚定无意义，最新锚定符合"缩放实时边缘"心智。
- 不做缩放倍率/灵敏度设置项：`ZOOM_STEP`、`MIN_VIEW` 为常量已足够；后续按需提升为设置。

