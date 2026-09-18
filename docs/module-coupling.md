# 模块耦合性分析报告（2026-09-18）

> 工具：dependency-cruiser 18.3.1（已在 devDependencies），配置 `.dependency-cruiser.cjs`
> 数据口径：133 个非测试模块，354 条模块间依赖边（不含 node_modules / .spec.ts）

## 结论摘要

源码整体分层是健康的：**Electron 三进程边界干净**（渲染层无任何 → `src/main` / `src/preload` 的边），`components → composables → stores + utils` 的主流向符合直觉。但存在 **5 个耦合问题**，其中两个已经形成环，建议按 P0–P2 处理：

| 级别 | 问题 | 规模 |
|---|---|---|
| P0 | `stores/` 四连环循环依赖 | messages ⇄ pause ⇄ waveform ⇄ serial（6 条环边） |
| P0 | `types.ts` 与 `decoders/types.ts` 类型回环 | 2 条边（类型级，危害小） |
| P1 | stores/utils 反向依赖 composables（层次倒挂） | 7 处 |
| P2 | utils 反向依赖会话模块 | 1 处（type-only，轻微） |
| P2 | 组件层直连 store + import 风格混用 | 6 处直连 / 298 别名 vs 202 相对 |

工具侧已把原来空的 `forbidden: []` 升级为 5 条规则，当前 **12 violations（4 error + 8 warn）**，`depcruise src` 退出码 4（可作 CI 门槛）。

> **2026-09-18 整改完成**：P0 两组环、P1 层倒挂、P2 import 统一全部落地，`depcruise src` 已归零（141 模块 / 374 依赖，0 违规），两条层规则升级为 error 防回归。明细见文末「整改记录」。MCP 合入 master（cfbb27b）后复检未引入新问题。

---

## 1. 总体视图（文件夹级耦合）

```
folder        in   out
components.   29  124     // 依赖大头：composables(41) + utils(31)
stores.       32   57
utils.        94   30     // 全仓最大“被依赖方”，事实上的共享工具层
composables.  58   21
serial.       15   19
session.      12   18
themes.       23   16
decoders.     19   12
main.         11   15     // Electron 主进程
types.ts.     47    1     // 共享类型枢纽，几乎全仓都引它
```

主进程 `src/main/` 只使用 `utils/logger`、`utils/log-level`、`utils/updater`（纯逻辑下沉），`preload` 只引 `utils/updater` 类型——**IPC 三进程没有互相穿透**，这是结构上最好的部分。

---

## 2. 问题一：stores 四连环循环依赖（P0）

```
stores/messages.ts → stores/pause.ts → stores/messages.ts
stores/pause.ts    → stores/waveform.ts → stores/pause.ts
stores/waveform.ts → stores/serial.ts → stores/messages.ts
```

代码证据（互相 `useXStore()` 取对方状态）：

- `stores/pause.ts:3-4` → `useMessagesStore`、`useWaveformStore`
- `stores/waveform.ts:6-7` → `useSerialStore`、`usePauseStore`
- `stores/serial.ts:16` → `useMessagesStore`
- `stores/messages.ts:10` → `usePauseStore`

C++ 类比：相当于四个类互相 include 对方的头文件。目前没崩是因为 pinia 的 `useStore()` 是惰性解析（运行时才在函数体内取实例），ESM 循环导入没触发 TDZ；但**数据流是结网的**——改 pause 的状态语义要同时理解 messages/waveform 的读取路径，任何一次初始化顺序变化都可能变成运行时问题。dependency-cruiser 已用 `no-circular` 规则锁死（error 级）。

## 3. 问题二：types.ts ⇄ decoders/types.ts 回环（P0/P2）

```
src/types.ts:2           import type { DecodeInfo } from '@/decoders/types'
src/decoders/types.ts:4  import type { ChecksumAlgorithm } from '@/types'
```

两条都是 `import type`，编译期即擦除，**运行时无风险**，所以危害等级可以降。真正的症状是：全仓 47 个模块依赖的共享类型枢纽 `types.ts` 反向引进了子模块 `decoders/` 的类型。`ChecksumAlgorithm`（被 decoder 引用）和 `DecodeInfo`（被根 types 引用）两个类型互相依赖，说明它们放错了容器——应该一起挪到公共类型层。
（C++ 类比：公共头文件反向 include 了子系统的头文件，会让依赖方向颠倒。）

## 4. 问题三：层次倒挂——stores/utils 反向依赖 composables（P1）

约定应是 `组件 → composables → stores`，stores 和 utils 是叶子。目前：

```
stores/messages.ts → composables/useFrameSplitter.ts   // 纯逻辑，应下沉 utils
stores/serial.ts   → composables/useStorage.ts
stores/settings.ts → composables/useStorage.ts
stores/commands.ts → composables/useStorage.ts
stores/recorder.ts → composables/useFileWriter.ts + useRecordDirectory.ts
utils/persist.ts   → composables/useStorage.ts        // utils 依赖 composables，最离谱
```

`useStorage.ts`（5 处反向依赖）本质是「localStorage 读写」基础设施，放在 `composables/`（UI 组合层）里名不副实——它被 3 个 store、persist、session/index 共用，实际扮演的是 utils 角色。`useFrameSplitter`、`useFileWriter`、`useRecordDirectory` 被 store 使用说明它们是纯逻辑，不是 UI 生命周期组合。
（C++ 类比：底层库 include 回业务层/UI 层，会导致任何上层改动波及底层。）

## 5. 问题四：session/index.ts 的角色过载（P2 观察项）

`src/session/index.ts` 是全仓最大枢纽（9 in / 16 out），但它**不是坏味道的典型**——它是「组合根 + 会话外观」：

- 16 条出边里 10 条指向 `stores/`，因为它用 `createXxxStore()` 工厂按会话创建各 store 并在 effectScope 里接线，这是它的职责；
- 9 条入边来自 App / SessionPanel/Pane/Tab / useSession / SettingsModal 等——组件通过它拿会话实例，**这解释了为什么 components → stores 直连只有 6 条**：会话级 store 必须经由 session/index 创建，组件层的间接性其实做得不错。

真正的隐患是两个次要点：

1. **同文件三身份**：它同时是工厂（create 函数）、会话类型出口（`export type Session`）、组合根。`utils/composer.ts` 因 `import type { Session }` 反向依赖它（P2，type-only）。
2. `session/` 文件夹内含一个纯叶子 `checksum.ts`（被 stores/messages 引用），与工厂 `index.ts` 混在一个命名空间里，文件夹级统计会虚高「session → stores」的耦合读数。

## 6. 问题五：组件直连 store 与 import 风格（P2）

- 6 处组件直连 store（绕过 composables）：MenuBar→commands/settings、QuickCommandsPanel→commands、SettingsModal→settings、DashboardPane→dashboard、FileTransferDialog→transfer。这些大多`是"薄 UI 直读状态"，Vue 生态可接受，但和"组件走 composables"的主流路径不一致，属于**无明确约定的分叉**，建议定一个立场统一。
- Import 风格混用：298 处 `@/` 别名 vs 202 处相对路径（同一个文件里两种都有，如 `stores/serial.ts`）。`tsconfig paths` 已配 `@/*`，建议统一 `@/`。

---

## 7. 工具落地：规则与当前违规清单

`.dependency-cruiser.cjs` 已从空规则升级为 5 条：

| 规则 | severity | 报什么 |
|---|---|---|
| `no-circular` | error | 两组环（问题一、二） |
| `not-to-unresolvable` | error | 无法解析的导入 |
| `no-orphans` | warn | 无被依赖的孤儿（已排除 main/preload/renderer/test 入口） |
| `not-to-composables-from-stores-and-utils` | warn | 问题三的倒挂 |
| `not-to-session-from-utils` | warn | 问题五会话反向依赖 |

当前 `npx depcruise src` 输出 **4 error + 8 warn**，退出码 4。除「环」之外全是 warn 级，不会阻断——等 P0/P1 整改完再把对应 warn 升 error。

> 注意：配置文件名从 `.dependency-cruiser.js` 改为 `.dependency-cruiser.cjs` —— 因 package.json 是 `"type": "module"`，`.js` 会被当 ESM 解析而 `module.exports` 直接报错。

## 8. 整改建议（按优先级）

1. **P0 拆环**：让 `pause` 不再直引 `messages`/`waveform`（改为注入回调/事件，或把状态上提），`waveform` 不再直引 `serial`（通过 action 而非跨 store 读 ref）。拆完 `no-circular` 应清零。
2. **P0 修类型回环**：把 `ChecksumAlgorithm` 与 `DecodeInfo` 收敛到一个公共类型模块（如 `src/types.ts` 或新建 `src/decoders/types` 之外的类型层），消除 `decoders/types ↔ types` 互引。
3. **P1 下沉**：`useStorage` 从 `composables/` 移到 `src/utils/`（或新建 `src/storage.ts`），同步改 5 处引用；`useFrameSplitter`/`useFileWriter`/`useRecordDirectory` 若确认无 UI 依赖，一并下沉。
4. **P2 统一**：import 全部改 `@/`；组件直连 store 的 6 处定为规范或改走 composables。
5. **P3 CI 化**：把 `npx depcruise src` 加入 CI（如 `verify:*` 脚本族），拦截新增环。

## 附录：复现命令

```bash
npx depcruise src --config .dependency-cruiser.cjs -T err     # 违规清单
npx depcruise src --config .dependency-cruiser.cjs -T dot | dot -T svg > /tmp/graph.svg
npx depcruise src --config .dependency-cruiser.cjs --metrics -T json -f /tmp/metrics.json
```

## 整改记录（2026-09-18）

按报告顺序 1→2→3→4 全部完成，`npx depcruise src` 归零（141 模块 / 374 依赖，0 违规），765 测试全绿。

**1. stores 四连环（P0）** — 四个 store 的 pinia 单例集中到新模块 `src/stores/singletons.ts`。
工厂（`createXStore(deps)`）本就是纯 DI，环只存在各文件底部的单例接线互相顶层 import。
单例收敛到同一容器后，`messages.ts`/`pause.ts`/`waveform.ts`/`serial.ts` 恢复叶子地位
（`transfer.ts`/`recorder.ts` 的单例改为从 `./singletons` 引 peer）。行为零变化（pinia id 不变）。

**2. types.ts ⇄ decoders/types.ts 类型回环（P0）** — `ChecksumAlgorithm` 的真源本来就有两份
（utils/checksum.ts 内的私有定义 + types.ts 的重复定义）。以 `utils/checksum.ts` 为唯一真源，
`types.ts` 改 `import type` + `export type { ChecksumAlgorithm }` 转发（兼容既有 4 处导入方），
`decoders/types.ts` 改引 utils。`types.ts → decoders/types` 的 `DecodeInfo` 引用保留（合法叶向）。

**3. 层倒挂（P1）** —— 四个「被 store 调用却住在 composables」的模块下沉 utils：
`useStorage`→`utils/storage.ts`、`useFrameSplitter`→`utils/frame-splitter.ts`、
`useFileWriter`→`utils/file-writer.ts`、`useRecordDirectory`→`utils/record-directory.ts`
（保留 `useRecordDirectory` 导出名；它虽有 vue ref，但属单例基础设施，utils 允许依赖 vue）。
21 处导入方同步改路径（含 `recorder.spec.ts` 的 `vi.mock` 路径——漏改导致 11 例失败，已修）。

**4. import 统一（P2）** —— 全仓 src 模块级相对导入改写为 `@/` 别名：
528 处 `@/`、0 处相对（余 8 处 CSS 副作用 `import './styles/*.css'` 保留相对）。
tsconfig 两份与 vite 全局 alias 均已配 `@/*`，主进程（tsc -p tsconfig.node.json）验证通过。
另 `utils/composer.ts` 参数收窄为 `ComposerSession`（仅 viewMode/composerText 的最小结构类型），
消除 utils→session 的 type-only 倒挂。

**组件直连 store 规范（第 4 项）** —— 审计 6 处直连后定案：**不改代码**。它们分两类，均合规：
(a) 全局单例 store（MenuBar/QuickCommandsPanel→`useCommandsStore`，MenuBar/SettingsModal→`useSettingsStore`）；
(b) 纯函数/常量/类型随模块导出（DashboardPane→`fieldStatus`/`DashboardWidget`，FileTransferDialog→`PRESETS`）。
规范性表述为：**组件可直连全局单例 store 与 store 模块导出的纯函数/常量/类型；会话级 store 实例必须经 `useSession()` 获取**。
未加 depcruise 规则（字段级 value/type 混引无法精确区分，会误伤 DashboardPane）。