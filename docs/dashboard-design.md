# 仪表盘（Dashboard）设计文档

> 实施状态：已完成（2026-08-15）。本文件记录数据流、绑定模型、widget 契约与后续扩展位。

## 定位

仪表盘把「帧解码器产出的结构化字段」实时呈现为 widget 卡片网格——数字表（大数字 + 阈值着色）、状态灯（阈值布尔）、字段总览表（最近一帧全部字段）。它与消息流互补：消息流看"历史与细节"，仪表盘看"此刻与状态"。典型场景是 Modbus 寄存器组轮询监控：设备周期性回寄存器，仪表盘一屏显示转速/电流/温度的当前值，越界自动变色。

数据源主线是**解码器字段驱动**（与波形视图的文本行数值管线互不耦合）：Modbus RTU 解码器输出 `registers` 多值字段 → widget 绑定第 N 个寄存器。文本行数值（Arduino `label:value` 风格）作为扩展位记录在文末，不在本期。

## 数据流

```
原始字节 → serial.onData → messages.makeRxMessage
                              │ decoder.decode(payload) 匹配成功
                              ▼
                 msg.decoded.fields（DecodeField：value 字符串 + number 数值）
                              │
              messages.onDecode(info) 广播（Set 订阅者模式，仿 serial.onData）
                              ▼
          dashboard store（会话内）
            ├─ latestFields：Map<`decoderId:fieldName:index`, FieldSnapshot>
            │    widget 绑定取值源；shallowRef 替换 + version 递增作刷新信号
            └─ lastFrame：最近一帧完整字段列表（字段总览表渲染源）
                              ▼
          DashboardPane.vue → 卡片网格（watch dashboard.version 刷新）
```

关键语义：

- **解码器字段数值化**：`DecodeField` 新增可选 `number?: number | number[]`（`src/decoders/types.ts`）。标量数值字段（u8/u16/u32、Modbus slave/fc/reg 等）为 number；多值字段（Modbus registers）为 number[]，与 value 字符串顺序一致。hex/ascii/utf8 无数值语义，省略该字段。value 字符串保留 → 气泡渲染/导出/搜索零改动（向后兼容）。
- **暂停语义**：messages 在 paused 时 `ingestRx` 提前 return，广播天然冻结 → 仪表盘自动冻结，与消息/波形视图对齐。
- **清空联动**：`pause.clearAll` 一并清 dashboard 数据快照（保留 widget 配置），三个视图（消息/波形/仪表盘）共享同一清空操作。

## 绑定模型

```
DashboardBind = { decoderId: string, fieldName: string, index?: number }
```

- `decoderId` + `fieldName` + `index`（多值字段下标，从 0 起）唯一确定一个数值。
- 键 `fieldKey = \`${decoderId}:${fieldName}:${index ?? ''}\``。
- 纯 JSON，可持久化。

## Widget 契约

```ts
DashboardWidget = {
  id: string                 // 会话内唯一，addWidget 生成
  type: 'digital' | 'led' | 'field-table'
  label: string
  bind?: DashboardBind       // field-table 无 bind
  unit?: string              // 数字表单位
  decimals?: number          // 数字表小数位（0–6）
  thresholdLow?: number      // 硬阈值下限（低于 → alarm）
  thresholdHigh?: number     // 硬阈值上限（高于 → alarm）
  warnLow?: number           // 软阈值（扩展位，表单未暴露）
  warnHigh?: number
}
```

阈值判定纯函数 `fieldStatus(widget, value)`（`src/stores/dashboard.ts`）：无值/非有限 → normal；alarm 优先于 warn；边界等于不算；单侧阈值只校验该侧。alarm 红色（卡片边框呼吸闪烁 + 数字/圆点着色），warn 琥珀色，normal 主色（LED 为绿色）。

## 交互入口

1. **右键字段 chip 添加**（主入口）：消息气泡的解码字段 chip 上右键 → 菜单「添加至仪表盘」。多值字段（如 Modbus 寄存器组）列出每个值的子项（`registers[2] = 100`）。自动创建数字表卡片：标签 = 字段名（多值带下标）、阈值上限 = 当前值 ×2（可再编辑）。
2. **面板内 + 添加**：仪表盘面板右上角 `+` → 配置弹窗（类型/标签/解码器/字段/索引/单位/阈值/小数位）。字段名下拉支持 filterable+tag（最近一帧字段名 + 字段布局配置的字段名作为候选项，也允许手动输入任意字段名）。
3. **卡片管理**：卡片右上角 ⚙ 编辑 / × 移除；卡片可拖拽排序（原生 HTML5 draggable）。

## 持久化

- widget 配置按端口持久化，键 `dashboard-config:${port}`（localStorage，`kart:` 前缀），与 `decoder-config:${port}` 同构：切端口载入该端口配置，变更（deep watch, flush:'sync'）写回；首端口且无已存配置时沿用内存配置并落盘（连接前添加的 widget 不被端口切换清掉）。
- 数据快照（latestFields/lastFrame）不持久化——断开/重连即从新数据重建。

## 接入面

- `src/stores/dashboard.ts`：会话内 store + `fieldStatus`/`fieldKey` 纯函数（单测 13 例）。
- `src/stores/messages.ts`：`onDecode` 订阅者（DecodeBroadcast 广播）。
- `src/session/index.ts`：创建 dashboard store、按端口持久化 watcher、挂到 session（第 8 个 store）。
- `src/components/DashboardPane.vue`：面板（dockview 内容组件）。
- `src/components/SessionPane.vue`：PANEL_IDS/components/panelTitle/默认布局（四面板）。
- `src/components/ViewTab.vue`：dashboard tab 图标 + `--accent-violet` 主题色。
- `src/components/MessageBubble.vue`：字段 chip 右键菜单。
- 主题：新增 `--accent-violet` token（TOKEN_KEYS + 3 内置主题 + tokens.css 亮/暗 fallback）。仪表盘状态色复用既有 `--ok/--warn/--err`。

## 已知限制

- 字段总览表只显示**最近一帧**字段（跨帧混合的"每字段最新值"未做表格聚合）。
- 阈值预警（warn）档配置表单未暴露（store 已支持，留作扩展）。
- 无值/断开时数字表显示 `—`，LED 熄灭（灰）。
- 卡片网格列数随宽度自适应（`auto-fill, minmax(200px,1fr)`），不支持手动调整单卡片宽高。

## 后续扩展位（不在本期）

1. **gauge 弧线仪表**：SVG 弧形 + 指针 + 阈值色区；数据源与数字表相同（bind 模型不变），新增 `type: 'gauge'` 即可。
2. **文本行数值数据源**：widget 绑定波形管线（`parseTextSamples` 的 label:value），绑定模型扩展一个 `source: 'text-line'` 分支——需要 waveform 侧暴露按标签的最新值。
3. **告警联动**：LED 跟随另一 widget 的状态（如"温度超限"红灯），绑定模型加 `followsWidgetId`。
4. **sparkline 迷你趋势**：数字表下方画最近 N 个采样的小折线（复用 dashboard store 或订阅波形数据）。
5. **自由布局**：卡片可拖拽改变宽高（布局引擎 + 持久化复杂度上升，首期采用固定网格）。
