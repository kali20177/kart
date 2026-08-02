# 计划：存储后端升级 —— 解决第 25 条「useStorage 同步无容量保护」

## 目标

解决 [docs/production-gaps.md](docs/production-gaps.md) 第 25 条：持久化全走同步 localStorage（~5MB 配额、满时静默吞写、Electron 下不受控），并为未来切换 electron-store 做准备。

## 核心原则

- **`useStorage.ts` 的 API 保持不变**（同步 `{ get, set, remove }`）——调用方零改动，切换成本最低，符合文件头「阶段 2 换 electron-store（接口不变）」的既定设计
- **新增一个异步直写后端**，由持久化的时刻决定走哪条路：
  - 高频小数据（布局/光标/临时）→ **内存 + 同步异步镜像**，立即可见，写失败静默（现状）
  - 用户数据（设置/命令/波特率/导出偏好/录制目录）→ **写入即落盘**（localStorage 同步 + IDB/主进程文件异步），不依赖低频的 deep watch
- 容量监控不依赖配额事件：**落盘的同时记录占用字节**（数据结构以 JSON 字符串规模计），≥1.5MB 时全量快照导出为 .json 文件（浏览器触发下载 / Electron 走 dialog 保存）并 toast 提醒

## 现状盘点（已核实）

### 调用方与键位

| 键 | 调用方 | 类型 | 量级 |
| --- | --- | --- | --- |
| `settings` | settings.ts（读+6 次迁移写+deep watch 写）、main.ts、i18n.ts | 用户数据 | 小 |
| `commands` | commands.ts（读+deep watch 写） | 用户数据 | 中 |
| `customBaudRates` | serial.ts（读+写） | 用户数据 | 小 |
| `autoSave` | settings.ts | 用户数据 | 小 |
| `export-preferences` | ExportDialog.vue（读+关闭时写） | 用户数据 | 小 |
| `record-dir-name` / `record-dir-path` | useRecordDirectory.ts | 用户数据 | 小 |
| `app:rightWidth` | App.vue useStorage | 布局 | 小 |
| `inputHeight` | InputComposer.vue useStorage | 布局 | 小 |
| `sendHistory` | useSendHistory.ts useStorage | 临时 | 中 |

### 关键事实

- `storage` 是模块级同步单例；`useStorage`（@vueuse）返回响应式 ref，写入靠各自组件的 `watch` 或 vueuse 内部 watch
- settings/commands 的 deep watch 是**同步 + 低频**（vue watch 默认 flush:'pre'，每 tick 一次），而 `autoSave` 开关、`serial.ts` 的 `storage.set`、ExportDialog、录制目录都是**直接同步调用**——这些是可靠的落盘点
- 主进程已有 `dialog`、`fs`、IPC 基础设施（recorder:show-directory-picker 先例）；preload 通过 `contextBridge` 暴露 API；渲染端类型在 `electron-env.d.ts` 的 `window.electron` 上
- 浏览器端已有 IndexedDB 基础设施：`logger.ts` 的 `openDB()` + `useRecordDirectory.ts` 的 `openDb()`
- 首次加载用 localStorage 同步读取（main.ts:38 首帧主题、settings.ts:36、i18n.ts:17）——**保持 localStorage 作为同步读源**
- 无持久化数据迁移代码（各键是独立 JSON 值，新旧可并存）

## 架构

### 新增文件

- `src/utils/size.ts` — `estimateJsonSize(value): number`（JSON.stringify().length），纯函数 + 单测
- `src/main/JsonStore.ts` — 主进程 JSON 文件 store（KART 持久化路径；窗口关闭时把 localStorage 的 JSON 值落成文件）
- `src/utils/persist.ts` — 直写落盘封装：
  - `persistNow(key, value)`：localStorage 同步写（现状）+ 队列式异步镜像（浏览器 IDB / Electron IPC）
  - 配额自检（`estimateJsonSize` 累计 ≥1.5MB → 快照导出 + toast 提醒 + 内部限流标志）
  - 导出函数 `exportSnapshot(keys)`（浏览器下载 / Electron dialog 保存）
- `src/composables/usePersistLayout.ts` — 布局类小数据的响应式封装（替代 vueuse `useStorage`）：
  - 内存 ref 即时生效 + 同步 localStorage 写 + 异步镜像
  - 跨标签页同步保留（storage 事件监听）

### 改动点

| 文件 | 改动 |
| --- | --- |
| `src/main/index.ts` | 注册 `persist:save`（批量写 JSON 文件，防抖窗口关闭时 flush） |
| `src/preload/index.ts` | contextBridge 暴露 `persist.save(key, value)` |
| `src/electron-env.d.ts` | 补 `persist` 类型 |
| `src/composables/useStorage.ts` | 新增 `storage.saveNow(key, value)`（异步镜像入口）；保持 `get/set/remove` 同步语义不变 |
| `src/stores/settings.ts` | deep watch 改调 `saveNow`；读路径不变 |
| `src/stores/commands.ts` | deep watch 改调 `saveNow` |
| `src/stores/serial.ts` | `customBaudRates` 各处 `storage.set` 改 `saveNow` |
| `src/components/ExportDialog.vue` | `storage.set` 改 `saveNow` |
| `src/composables/useRecordDirectory.ts` | 两处 `storage.set` 改 `saveNow` |
| `src/App.vue` / `InputComposer.vue` / `useSendHistory.ts` | 换用 `usePersistLayout`（同步读 + 立即写） |
| `src/main.ts` | 窗口关闭前 flush 本地缓存到主进程（Electron 下），或保持现状（localStorage 已是同步落盘，浏览器无需 flush） |
| `src/test/setup.ts` | 提供 `persist.saveNow`/IDB 的测试桩（localStorage 已 stub） |
| 测试 | `persist.spec.ts`（镜像/限流/导出）、`size.spec.ts`；现有 spec 适配（serial.spec.ts 的 localStorage 断言、commands/settings 如有） |

## 实施步骤

1. **`src/utils/size.ts`** — `estimateJsonSize` + 单测
2. **`useStorage.ts` 扩展** — `saveNow`：同步写 localStorage + 限流自检；异步镜像封装 `mirrorSave`（浏览器 → IDB `kart-persist` store；Electron → `window.electron.persist.save`）
3. **主进程/preload/IPC** — `JsonStore`（`userData/kart-settings.json` 单文件 + 原子写 `fs.writeFileSync` 到临时文件再 rename；防抖 500ms）+ `persist:save` handler + preload 暴露 + 类型
4. **迁移调用方** — 按上表逐个把直接 `storage.set`/deep watch 改 `saveNow`；布局键换 `usePersistLayout`
5. **容量监控** — `saveNow` 内部维护占用字节估计，≥1.5MB 触发快照导出（浏览器 Blob 下载 / Electron dialog），toast 提醒，限流每会话一次
6. **测试** — 新单测 + 适配现有 spec（serial.spec.ts 的 localStorage 断言、session 相关）；`npm run typecheck`、`npm test`、`npm run lint` 全绿
7. **文档** — 更新 `docs/production-gaps.md` 第 25 条标 ✅；更新 CLAUDE.md「待完成事项」第 1 条

## 边界与取舍

- **不做**：跨进程读（主进程只写不读，所有读仍在渲染端 localStorage）——首次加载同步读依赖不变，零闪烁
- **不做**：完整 electron-store 接入（异步签名会破坏所有同步调用方 + main.ts 首帧同步读），本计划已让持久化正确落盘 + 容量保护
- **Electron 路径**：IPC 写盘失败时记录日志并保留 localStorage（尽力而为，不阻塞）
- **浏览器路径**：IDB 失败时静默降级（同现状）——IDB 本身就有容量自动清理机制（eviction），是浏览器端正确选择
- **迁移**：各键 JSON 值新旧并存，无需数据迁移；`sendHistory` 等键仍留在 localStorage 同步读写，不受影响

## 验证

- `npm run typecheck`、`npm test`、`npm run lint`
- `npm run dev`（浏览器）：改设置 → 刷新 → 配置仍在；DevTools 检查 IDB `kart-persist` 有记录
- `npm run electron:preview`：改设置 → 检查 `userData/kart-settings.json` 内容正确；改布局宽度 → 重启应用仍在
