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
        按通道 append 进滑动窗口 data[ch][]
          X = startTime + sampleIndex++ * (1000/sampleRate)
          超 maxPoints 从头裁剪
                │
                ▼
        WaveformChart 组件 watch(data) + rAF 节流 → uPlot.setData(data)
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
- `onBeforeUnmount` → `chart.destroy()` + RO.disconnect + `waveformStore.unsubscribe()`。

## 8. 验证

1. `npm run typecheck` —— 唯一质量门禁，必须通过。
2. `npm test` —— `byte-parser.spec.ts` + `waveform.spec.ts` 全绿。
3. `npm run dev` —— 选「波形」场景 → 连接 → 切 `[波形]` 标签 → 双通道正弦波实时滚动；
   改通道数/大小端/采样率/最大点数，波形随之变化；切暗色主题配色跟随；拖拽窗口 uPlot 自适应；
   点清空缓冲重置。
4. **滚满验证**：窗口滚到 maxPoints 后波形仍持续滚动、点数稳定在 maxPoints
   （刷新信号用 `version` 版本号而非数组长度，避免窗口满后卡死）。

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

