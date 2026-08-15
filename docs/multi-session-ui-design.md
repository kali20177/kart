# 多会话 UI（App.vue tab 化）设计

> 关联：`docs/production-gaps.md` 第 14 点「单连接，不支持多端口并发」。
> 日期：2026-08-02。状态：待实施。

## 背景

主进程多端口化已完成（commit `4f792ca`），渲染端 `createSession`/`useSession` 已就绪（每会话独立驱动实例 + 独立 store 六件套），但 UI 仍是**单会话布局**——App.vue 只创建一个 session 并 provide，`provideSession` 包住整个子树。本设计将 App.vue 改为会话 tab 布局，使一个窗口内可同时连接多个串口（每 tab 一个会话）。

## 用户已确认的决策

- **布局**：完整会话区块 tab（每 tab 含 ConnectionBar + 视图 tab + 内容区 + StatusBar，多会话工具常规做法）
- **命令面板**：全局共享（commands store 本就是全局单例设计，点击发送到当前活动会话）
- **portOptions 落盘**：待用户确认（备选：停止自动落盘 / 接受覆盖冲突）

## settings 会话化评估（结论：本计划不做，先做 UI）

经核查（codegraph）：**波特率不在全局 settings**——`AppSettings`（types.ts L159-184）无 baudRate 字段，端口参数（baudRate/dataBits/stopBits/parity/flowControl）在 serial store 自己的 `options`（serial.ts L49-52），每个 `createSerialStore` 实例独立——**两端口不同波特率当前架构已天然支持**，无需下沉。

真正跨会话共享的是解析类设置：`encoding`/`frame`/`bufferLimit`/`sendChecksum`/`rxChecksumAlgorithm`/`waveform`（经 session/index.ts L57 同一 proxy 注入）。多会话 v1 共享这些是**可接受行为**（切 tab 时设置全局生效）；会话化拆分（AppSettings 拆 Global+Session、store deps 改签名、SettingsModal 重构、持久化改造）是**纯重构**——单会话下零用户可见变化，风险高收益低，且拆的时候有 UI 可对照验证。**记为已知后续项**，本设计不实施。

> **2026-08-15 更新**：其中的校验和部分已实施——`sendChecksum`/`rxChecksumAlgorithm` 移出 AppSettings，改为会话级 `session.checksum`（`ChecksumConfig`，按端口持久化，ConnectionBar 弹窗编辑，见 `src/session/index.ts`）；多会话各配各的校验方式，旧全局值经 settings store 七次迁移播种首端口。`encoding`/`frame`/`bufferLimit`/`waveform` 仍为全局共享。

## 现状（已核实）

- App.vue：`createSession()` 单会话（L25）+ `provideSession`（L27）包住整个 `.app` 子树；现有 tab 是**视图级**（`mainView = ref<'messages'|'waveform'>`，L50），非会话级；`.view-tabs` 样式（L232-257）可扩展为会话 tab 条
- 组件 store 获取：9 个组件已用 `useSession()`（ConnectionBar/InputComposer/MessageList/WaveformChart/StatusBar/ExportDialog/FileTransferDialog/FileTransferBubble），**4 个混用全局单例**：MenuBar（settings/commands）、QuickCommandsPanel（commands）、SettingsModal（settings）——但 settings/commands 本身是**有意的全局设计**（无 create 工厂，跨会话统一），非 bug
- store 内部干净：所有 `createXxxStore` 均 deps 注入，全局单例仅存于文件末尾 `useXxxStore` 包装（测试/兼容用）
- main.ts 无全局 provide；无 router
- 全局 UI 态（App 本地 ref）：`showAscii`/`showSettings`/`showFileTransfer`/`commandsCollapsed`/`rightWidth`/`composerText`——其中 `composerText`/`mainView` 属会话态应随 tab；`rightWidth` 全局布局态可共享
- **已知冲突点**：serial 的 `portOptions` 自动落盘 localStorage（全局键 `portOptions`），多会话 connect 时互相覆盖初始值

## 关键发现（复查新增）

1. **根层对话框会话上下文问题**（关键）：AsciiTable/SettingsModal/FileTransferDialog 挂在与 `.app` **同级**的 NDialogProvider 下（App.vue L206-208），当前靠 `.app` 的 provide 向下传播覆盖；会话 provide 移入 SessionPane 后它们失去上下文，`useSession()` 会 throw → 全部改 `useActiveSession()`
2. **对话框 opener 会话绑定**：FileTransferDialog 由会话内 InputComposer 触发，SettingsModal 由 ConnectionBar 触发——触发后切 tab 的场景需 openerSessionId 绑定（v1 方案：App 记录 opener 会话 id，对话框取之）
3. **AsciiTable 插入目标**：`onInsertAscii`（App L138-146）写 composerText，多会话后需落到当前活动会话的 composer
4. **ExportDialog 不用改**：在 MessageList 内（会话上下文内，安全）
5. **MenuBar 当前在会话 provide 内**（非根层外），tab 化移出后改 `useActiveSession`
6. **单会话默认行为**：启动即 1 个 tab，与现状一致

## UI 布局（ASCII 示意）

会话 tab 条位于 MenuBar 下方；每个 tab 内是完整会话区块（ConnectionBar + 视图 tab + 内容区 + StatusBar），`v-show` 切换保留各会话 scope 存活（隐藏 tab 波形仍缓冲）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 文件  编辑  视图  设置(全局)              [亮/暗] [语言]        ← MenuBar  │
├──────────────────────────────────────────────────────────────────────────┤
│  [会话1 ●COM5] [会话2 ○/dev/ttyUSB0 ×] [+] 新建       ← 会话 tab 条(新增) │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────┬────────────────────────────────────┐ │
│ │  [消息 | 波形]  ← 视图级 tab    │  [‹/›] 快速命令侧边栏(全局共享)     │ │
│ │  ┌─ ConnectionBar ────────────┐ │  ┌──────────────────────────────┐ │ │
│ │  │  [端口▾] [波特率▾] [打开] …│ │  │  命令列表                    │ │ │
│ │  └────────────────────────────┘ │  │  [点击发送 → 当前活动会话]    │ │ │
│ │  ┌─────────────────────────────┐ │  │                              │ │ │
│ │  │  消息列表 (RX/TX 气泡)      │ │  │                              │ │ │
│ │  ├─────────────────────────────┤ │  │                              │ │ │
│ │  │  波形图 (v-show 切换)       │ │  └──────────────────────────────┘ │ │
│ │  ├─────────────────────────────┤ │                                   │ │
│ │  │  输入框 composer             │ │                                   │ │
│ │  └─────────────────────────────┘ │                                   │ │
│ │  ┌─ StatusBar ─────────────────┐ │                                   │ │
│ │  │  ●连接 9600-8N1 RX:1.2k TX:0│ │                                   │ │
│ │  └─────────────────────────────┘ │                                   │ │
│ └─────────────────────────────────┴────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

会话 tab 条细节（tab 上显示连接态 + 端口名，便于多端口区分）：

```
┌───────────────────────────────────────────────────┐
│ [会话1 ●COM5] [会话2 ○/dev/ttyUSB0 ×] [+]      │
│   ▲活动(高亮)   ▲非活动,×=关闭(仅剩1个时禁用)     │
└───────────────────────────────────────────────────┘
```

关键交互：

- **切换 tab** = 切显示（`v-show`），各会话 scope 存活、波形继续缓冲
- **关闭 tab** = `dispose()`（断口 + 清定时器）；最后一 tab 禁止关闭
- **全局层**：MenuBar、快速命令面板、设置/文件传输/ASCII 表对话框、IncompatibleBrowser 遮罩——作用于当前活动会话（对话框按 opener 会话绑定，见 Step 3）
- **单会话行为**：启动即 1 个 tab，与改造前布局完全一致

## 实施步骤

### Step 1 — App.vue tab 化

- 会话状态：`sessions = ref<Session[]>([])` + `activeSessionId = ref<number>(0)`（或 index），提供「新建会话」「关闭会话」操作
- 布局重构：`.app` 顶部加会话 tab 条（复用 `.view-tabs`/`.tab` 样式或新建 `.session-tabs`），每 tab 一个会话区块（`ConnectionBar` + 视图 tab + 内容区 + `StatusBar` 包在一个子容器内），`v-show` 按 `activeSessionId` 切换（保留各会话 scope 存活，波形隐藏仍缓冲——沿用现 `mainView` 的 v-show 模式）
- `provideSession`：需在**每个会话区块内**分别 provide 对应 session（不能在顶层 provide 单一会话）。方案：抽一个 `SessionPane.vue` 子组件，接收 `session` prop，内部 `provideSession(session)` 后渲染 ConnectionBar/视图/StatusBar——`provide` 是组件树作用域，天然隔离
- **会话态组件/状态迁移**：`MessageList`/`WaveformChart`/`InputComposer`/`ConnectionBar`/`StatusBar` 全部移入 SessionPane（已 useSession，天然绑定本 tab）；`mainView`/`composerText`/`viewMode` 从 App 移到 SessionPane 内部 ref（会话态）；`onResend`/`onToComposer`/`onOpenFileTransfer`/`onInsertAscii` 的 composer 操作跟随下移
- 会话生命周期：新建时 `createSession()` 并 push；关闭时 `session.dispose()`（effectScope 清理定时器/订阅/驱动）+ 从数组移除；关闭活动 tab 时切换 active 到相邻 tab
- **末 tab 保护**：禁止关闭最后一个 tab（关闭按钮在仅剩 1 个时禁用），否则 UI 退化为空白无会话区，且 `useActiveSession` 会拿到 undefined
- 全局区保留：MenuBar、右栏命令面板（QuickCommandsPanel）、AsciiTable、SettingsModal、FileTransferDialog 等对话框在会话区块外（全局，改 `useActiveSession`，见 Step 2/3）；`IncompatibleBrowser` 也放全局区（任一会话 unsupported 即全屏遮罩，各会话共用）
- `rightWidth`/`commandsCollapsed` 保留全局；`inputRef`/焦点管理：切换 tab 时焦点处理（可选）
- **单会话默认行为**：启动即创建第 1 个会话 tab（默认 1 个 tab，与现状一致），后续可新建/关闭

### Step 2 — 混用全局单例组件清理 + 根层组件会话上下文问题（关键修复）

**核心问题：3 个根层对话框当前在会话上下文之外渲染，但用了 `useSession()`，多会话后仍会 throw。** 现状：`App.vue` 把 `AsciiTable`/`SettingsModal`/`FileTransferDialog` 挂在与 `.app`（会话 provide 内）**同级的 NDialogProvider 下**（L206-208），当前单会话时 `.app` 的 provide 覆盖到它们（provide 沿组件树向下传播）。**多会话后会话 provide 移到各 SessionPane 内，这些根层组件将失去会话上下文**——必须改为 `useActiveSession()`。

- **SettingsModal**（L24 `useSession().serial`）：serial 仅用于自定义波特率（customBaudRates 等）——改 `useActiveSession()`（设置弹窗针对当前活动会话的端口参数）
- **FileTransferDialog**（L32 `useSession().serial/transfer`）：改 `useActiveSession()`（文件传输针对当前活动会话）
- **AsciiTable**：无 store，但 App 的 `onInsertAscii`（L138-146）写 `composerText`——多会话后 composerText 会话化，插入必须落到**当前活动会话的 composer**。实现：SessionPane 暴露 `insertAscii(entry)` 方法（`defineExpose`），App 维护 `sessionPaneRefs: Record<id, SessionPaneInstance>`（或 `ref<InstanceType<typeof SessionPane>>[]`），`onInsertAscii` 按 `activeSessionId` 转发到对应 pane
- **MenuBar**（L16 `useSession().serial/recorder`）：当前在 `.app` 内（会话 provide 内）正常工作；tab 化后移出会话区块 → 改 `useActiveSession()`（驱动切换/录制菜单针对当前活动会话）
- **QuickCommandsPanel**（L27 `useSession().serial` 发送）：改 `useActiveSession()`（命令发送到当前活动会话）
- **ExportDialog**：在 MessageList 内（会话上下文内，安全，**不用改**）
- settings/commands 全局单例保持（本就全局设计，非 bug）

### Step 3 — 当前活动会话的全局访问

- 新增 `provideActiveSession()`/`useActiveSession()`（或直接在 App 提供 `activeSessionRef`），供全局区组件（MenuBar/QuickCommandsPanel/SettingsModal/FileTransferDialog）获取当前活动会话
- 实现：App 维护 `activeSession = computed(() => sessions.value[activeSessionId])`，经 provide 暴露；全局组件 `useActiveSession()` 取之，替代 `useSession()`
- 与现有 `useSession()`（会话区块内）区分：会话内组件用 `useSession`（拿到本 tab 会话），全局组件用 `useActiveSession`（拿到当前活动 tab 的会话）
- **对话框 opener 会话绑定（v1 采用）**：FileTransferDialog/SettingsModal 由会话内组件触发（InputComposer 的 📎、ConnectionBar 的设置），但渲染在根层。App 记录 `openerSessionId`，**每次打开时重新赋值**，对话框经 prop 取该会话——即使触发后立即切 tab，对话框仍作用于「打开那一刻」的会话。仅「打开」那一刻绑定，不追踪后续切 tab（打开后切换 tab 不影响已打开的对话框）。

### Step 4 — portOptions 落盘处理（待用户确认方案）

- 方案 A（推荐）：移除 serial.ts L135/L425 的 `storage.set('portOptions', ...)`，端口参数仅存会话内存。理由：多会话无法区分「哪次落盘是用户意图」；会话 tab 不持久化，记忆意义有限。保留 `storage.get` 初始读取（兼容单会话时记忆）。
- 方案 B：保持现状（接受默认值互相覆盖）

### Step 5 — 验证

1. `npm run typecheck` + `npm run lint` + `npm test`
2. `npm run electron:dev` 手测：
   - 新建 2 个会话 tab，各连不同串口，互发数据互不干扰
   - 切换 tab，各会话连接状态/消息列表/波形独立保留
   - 关闭活动 tab → 主进程确认对应端口关闭，其他 tab 不受影响
   - 关闭非活动 tab → 其他 tab 不受影响；仅剩 1 个 tab 时关闭按钮禁用
   - 全局命令面板发送到当前活动会话
   - 单会话模式（只开 1 个 tab）行为与改造前一致
   - 根层对话框（设置/文件传输/ASCII 表）打开后立即切 tab → 对话框仍作用于打开那一刻的会话；重新打开对话框指向新 tab
   - 录制/导出针对当前活动会话

## 涉及文件

- `src/App.vue` — 会话 tab 布局重构 + `provideActiveSession` + 根层对话框改活动会话
- `src/components/SessionPane.vue`（新建）— 会话区块：provideSession + ConnectionBar/视图/StatusBar + 会话态 ref（mainView/composerText）
- `src/components/MenuBar.vue` / `QuickCommandsPanel.vue` / `SettingsModal.vue` / `FileTransferDialog.vue` — 根层/全局组件改 `useActiveSession`
- `src/composables/useSession.ts` — 新增 `provideActiveSession`/`useActiveSession`（或并入）
- `src/stores/serial.ts` — portOptions 落盘处理（待定方案）
- `docs/multi-port-design.md` — 更新实施进度（可选）
