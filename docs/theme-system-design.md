# 主题模块架构设计

## Context

当前项目只有暗色/亮色切换（`data-theme="dark|light"`），修改 `tokens.css` 就会永久丢失原有风格。需要设计一个**开发者友好的主题模块系统**，使多个主题可共存、可切换，主题与业务逻辑完全解耦。

核心原则：
- **组件不感知主题** — 组件只消费 `var(--xxx)` CSS 变量和 Naive UI props，不 import 主题文件
- **主题是纯数据** — 每个主题是一个导出 `ThemeDefinition` 对象的 TS 模块，零逻辑
- **切换原子性** — 运行时切换主题时，所有视觉层（CSS 变量 + Naive UI 覆写）同步更新
- **现有风格保留** — 当前 GitHub-dark 玻璃工业风作为独立主题保留

## 架构决策：单态主题（非双态）

每个主题文件只定义**一种配色方案**，通过 `isDark: boolean` 标记明暗。这与 VSCode 等主流工具一致 —— Dark+ 和 Light+ 是两个独立主题，不是一个主题的两个 mode。

**为何不是双态（`tokens: { light, dark }`）**：
- 偏科主题（如 OLED HUD）只需维护一种配色，双态要求填两套、亮套多为凑数
- 无需模式选择器 → 主题列表是平坦的一维选择，用户一选即中
- 省去 `themeMode` 字段、`setMode()` 方法、单态偏科回退逻辑
- 符合 VSCode / JetBrains / Sublime / iTerm2 等主流工具的行业惯例

## 涉及的所有 CSS 变量（已按「实际消费 / 仅定义」区分，以 `grep -oE 'var\(--[a-z0-9-]+\)' src/components src/App.vue` 校准）

> 标注「✅消费」表示存在 `var(--xxx)` 消费者；「仅定义」表示只在 `tokens.css` 里设值、无消费者。提取主题文件时两者都要带上（仅定义的可一并迁移以免将来消费时漏值），但要知道当前视觉只依赖前者。`--bubble-font-size` 非主题变量，不纳入。

| 类别 | 变量 | 用途 | 状态 |
|------|------|------|------|
| 背景层级 | `--bg`, `--bg-panel`, `--bg-elevated` | 页面底 → 面板 → 抬高 | ✅消费 |
| 文本层级 | `--text`, `--text-dim` | 主文字 / 次级文字 | ✅消费 |
| 边框 | `--border` | 所有边框分隔线 | ✅消费 |
| 强调色 | `--accent` | 主强调 | ✅消费 |
| 强调色 | `--accent-cyan`, `--accent-teal` | 青色/蓝绿辅助 | 仅定义 |
| 语义色 | `--ok`, `--warn`, `--err` | 成功 / 警告 / 错误 | ✅消费 |
| 收发标记 | `--rx-bg`, `--rx-border`, `--rx-text` | 接收消息 | ✅消费 |
| 收发标记 | `--tx-bg`, `--tx-border`, `--tx-text` | 发送消息 | ✅消费 |
| 毛玻璃 | `--glass-bg`, `--glass-border`, `--glass-blur`, `--glass-blur-sm` | 玻璃效果（HUD 主题映射为实色） | ✅消费 |
| 阴影 | `--shadow-sm`, `--shadow-lg` | 两级阴影 ✅ | 消费；`--shadow-md` 仅定义 |
| 圆角 | `--radius`, `--radius-sm` | 四级圆角的 ✅消费子集 | 消费；`--radius-md/lg/xl` 仅定义 |
| 间距 | `--gap` | 间距 | 仅定义 |
| 搜索 | `--search-highlight-bg`, `--search-highlight-text` | 搜索命中 | ✅消费 |
| 搜索 | `--search-active-bg`, `--search-active-text` | 搜索当前导航 | ✅消费 |
| 字体 | `--mono-font`, `--ui-font` | 等宽 / UI 字体栈 | ✅消费 |
| 动态 | `--bubble-font-size` | **非主题变量**，由 settings store 动态设置（App.vue watch fontSize）— 不纳入主题文件 | — |

## 架构

### 目录结构

```
src/themes/
  types.ts                          # ThemeDefinition 接口 + 类型
  registry.ts                       # 主题注册表 + applyTokens 纯函数
  builtin/
    glass-industrial-dark.ts        # 现有 GitHub-dark 玻璃工业风（暗色）
    glass-industrial-light.ts       # 玻璃工业风（亮色）
    oled-hud.ts                     # Cyberpunk 终端 HUD 风格（暗色）
    retro-console.ts                # 复古游戏机像素风（暗色，0 圆角 + 硬边框 + 阶梯阴影）
  index.ts                          # 统一导出
```

### 核心类型 — `src/themes/types.ts`

```ts
import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * 全部主题 CSS 自定义属性的键集合（const 联合）。
 * 用联合做 key，让 TS 对拼写错误（如 '--raduis'）在构建期报错，
 * 补强「项目唯一质量门禁是 vue-tsc、无 linter」这一短板。
 */
export const TOKEN_KEYS = [
  '--bg', '--bg-panel', '--bg-elevated', '--text', '--text-dim', '--border',
  '--accent', '--accent-cyan', '--accent-teal', '--ok', '--warn', '--err',
  '--rx-bg', '--rx-border', '--rx-text', '--tx-bg', '--tx-border', '--tx-text',
  '--glass-bg', '--glass-border', '--glass-blur', '--glass-blur-sm',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--radius', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--gap',
  '--search-highlight-bg', '--search-highlight-text',
  '--search-active-bg', '--search-active-text',
  '--mono-font', '--ui-font',
  // 注意：--bubble-font-size 是业务动态变量，不纳入
] as const
export type TokenKey = typeof TOKEN_KEYS[number]

/** 单套 CSS 自定义属性 —— 拼写错误的 key 会在 vue-tsc 报错 */
export type ThemeTokens = Partial<Record<TokenKey, string>>

/** 一个完整主题定义（单态：每个文件只定义一种配色方案） */
export interface ThemeDefinition {
  id: string
  name: string
  description?: string
  /** 是否为暗色（供 uPlot 等 JS 逻辑判断配色 + 设置 data-theme 属性） */
  isDark: boolean
  /** 该主题的 CSS 变量值 */
  tokens: ThemeTokens
  /** Naive UI 主题覆写（可选，缺省用 Naive UI 默认） */
  naiveOverrides?: GlobalThemeOverrides
  /** Google Fonts 等外部字体 URL（可选）。注入策略见下方「字体注入」注释 */
  fonts?: string[]
}
```

- `ThemeTokens` 用 `Partial<Record<TokenKey, string>>` —— 几乎零额外抽象，却把拼写错误挡在 `vue-tsc` 之前；相比裸 `Record<string, string>`，`--raduis` 这种笔误会在类型检查期暴露，避免切主题后某组件静默用回 fallback。`Partial` 允许主题只覆盖关心的变量，未覆盖的回退到 `tokens.css` 默认值。
- 每个主题文件只导出一个 `ThemeDefinition` 对象，纯数据，无逻辑。
- `isDark` 决定 `NConfigProvider` 是否使用 `darkTheme`，以及 `data-theme` 属性值。

> **字体注入（fonts）**：`fonts` 是 Google Fonts 等外链 `<link rel="stylesheet">`。`useTheme` 切主题时需负责：
> 1. 把上一主题注入的 `<link data-theme-font>` 从 `<head>` 移除；
> 2. 把新主题 `fonts` 数组逐条创建为 `<link>` 加回，加 `data-theme-font` 标记便于下次移除。
>
> **CSP / 离线约束**（见记忆 [[i18n-must-precompile-csp]]）：当前项目 CSP 禁 `unsafe-eval`（i18n 已为它改用预编译），且 `font-src 'self' data:` 限制外链字体。外链字体在生产环境不会加载 → 主题必须把 fallback 字体栈写在 `--mono-font`/`--ui-font` 里（已做到：`--ui-font` 以 `'Inter',-apple-system...` 开头，Orbitron 加载失败时回退到 sans-serif）。结论：`fonts` 仅作锦上添花，**绝不能让视觉依赖外链字体是否加载成功**。

### 主题注册表 — `src/themes/registry.ts`

```ts
import type { ThemeDefinition } from './types'
import { glassIndustrialDark } from './builtin/glass-industrial-dark'
import { glassIndustrialLight } from './builtin/glass-industrial-light'
import { oledHud } from './builtin/oled-hud'

const registry = new Map<string, ThemeDefinition>()

// 内置主题注册
register(glassIndustrialDark)
register(glassIndustrialLight)
register(oledHud)

export function register(theme: ThemeDefinition): void { ... }
export function getTheme(id: string): ThemeDefinition | undefined { ... }
export function listThemes(): ThemeDefinition[] { ... }
```

注册表是 `Map<string, ThemeDefinition>`，`register()` 幂等（后注册覆盖同 ID）。

### `applyTokens()` — `src/themes/registry.ts`

纯函数，遍历 `tokens` 对象，逐项 `document.documentElement.style.setProperty(key, value)`。同时设置 `data-theme="dark|light"` 属性保持兼容。导出独立函数并支持脱离组件上下文调用（供 `main.ts` 在 createApp 前同步执行首帧应用）。

```ts
export function applyTokens(tokens: ThemeTokens, isDark: boolean): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    if (value != null) root.style.setProperty(key, value)
  }
  root.setAttribute('data-theme', isDark ? 'dark' : 'light')
}
```

### Composable — `src/composables/useTheme.ts`

核心逻辑，替代旧的 `useIsDark` + `App.vue` 中分散的主题逻辑。

```ts
export function useTheme() {
  const settingsStore = useSettingsStore()

  const themeId = computed<string>(() => settingsStore.settings.themeId ?? 'glass-industrial-dark')

  const theme = computed<ThemeDefinition>(() => {
    return getTheme(themeId.value) ?? listThemes()[0]
  })

  const isDark = computed(() => theme.value.isDark)

  const tokens = computed(() => theme.value.tokens)

  const naiveTheme = computed(() => (isDark.value ? darkTheme : null))

  const naiveOverrides = computed(() => theme.value.naiveOverrides)

  // themeId 切换 → 应用 CSS 变量
  watch(
    () => settingsStore.settings.themeId,
    (id) => {
      const t = getTheme(id) ?? listThemes()[0]
      applyThemeTokens(t.tokens, t.isDark)
    },
    { immediate: true }
  )

  function setTheme(id: string) {
    settingsStore.settings.themeId = id
  }

  // Dev 调试钩子
  if (import.meta.env.DEV) {
    const w = window as unknown as { __theme?: Record<string, unknown> }
    w.__theme = { setTheme, themeId, isDark, tokens }
  }

  return {
    themeId,
    isDark,
    naiveTheme,
    naiveOverrides,
    setTheme,
    listThemes,
  }
}
```

> **`isDark` 的外部消费者**：`src/components/WaveformChart.vue` 用 `useTheme().isDark`（`watch(isDark, () => rebuild())`，因为 uPlot canvas 不吃 CSS 变量，需 JS 读 computed style 重建）。`useTheme` 替代了 `useIsDark` 的全部两个消费者（App.vue + WaveformChart）。

### 主题文件示例 — `src/themes/builtin/oled-hud.ts`

```ts
import type { ThemeDefinition } from '../types'

export const oledHud: ThemeDefinition = {
  id: 'oled-hud',
  name: 'OLED HUD',
  description: 'Cyberpunk 终端风格，OLED 暗色 + 霓虹绿/青/琥珀',
  isDark: true,
  fonts: [
    'https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap',
  ],
  tokens: {
    '--bg': '#050508',
    '--bg-panel': '#0A0A0F',
    '--bg-elevated': '#12121A',
    '--border': '#1E1E2E',
    '--text': '#E0E0E8',
    '--text-dim': '#7A8A9A',
    '--accent': '#00E676',
    '--accent-cyan': '#00D4FF',
    '--accent-teal': '#00E676',
    '--ok': '#00E676',
    '--warn': '#FFB000',
    '--err': '#FF3366',
    // 方向色
    '--rx-bg': 'rgba(0,212,255,0.08)',
    '--rx-border': 'rgba(0,212,255,0.30)',
    '--rx-text': '#E0E0E8',
    '--tx-bg': 'rgba(255,176,0,0.08)',
    '--tx-border': 'rgba(255,176,0,0.30)',
    '--tx-text': '#E0E0E8',
    // 毛玻璃 → 实色映射（组件无感知）
    '--glass-bg': '#0A0A0F',
    '--glass-border': '#1E1E2E',
    '--glass-blur': '0px',
    '--glass-blur-sm': '0px',
    // 阴影
    '--shadow-sm': '0 1px 3px rgba(0,0,0,0.5)',
    '--shadow-md': '0 4px 12px rgba(0,0,0,0.5)',
    '--shadow-lg': '0 8px 24px rgba(0,0,0,0.6)',
    // 圆角 — 近乎直角
    '--radius': '2px',
    '--radius-sm': '2px',
    '--radius-md': '2px',
    '--radius-lg': '3px',
    '--radius-xl': '4px',
    '--gap': '8px',
    // 字体
    '--mono-font': "'JetBrains Mono','Cascadia Mono','Consolas',monospace",
    '--ui-font': "'Inter',-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
    // 搜索高亮
    '--search-highlight-bg': '#1A3D1A',
    '--search-highlight-text': '#00FF88',
    '--search-active-bg': '#2D5A1E',
    '--search-active-text': '#00FF88',
  },
  naiveOverrides: {
    common: {
      primaryColor: '#00E676',
      primaryColorHover: '#33FF99',
      primaryColorPressed: '#00C853',
      borderRadius: '2px',
    },
    Button: {
      borderRadiusTiny: '2px',
      borderRadiusSmall: '2px',
      borderRadiusMedium: '2px',
    },
    Input: {
      borderRadius: '2px',
    },
    Select: {
      menuBoxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    },
    Tag: {
      borderRadius: '2px',
    },
  },
}
```

关键设计：`--glass-bg` 等在 HUD 主题中映射为实色（`#0A0A0F`），组件 CSS 里 `var(--glass-bg)` 照用不误，但视觉效果变为无毛玻璃的实色面板。主题切换对组件完全透明。

### `App.vue` 简化

**Before**：
```
- useIsDark() composable     ← 被 App.vue 与 WaveformChart.vue 共用（两个消费者）
- 手动 watch isDark → set data-theme
- 手动 computed naiveTheme / themeOverrides（含大量硬编码覆写 + isDark 三元）
- 手动 watch fontSize → set --bubble-font-size
```

**After**：
```
- useTheme() composable 一行获取全部（替代 useIsDark；其两个消费者 App.vue、WaveformChart.vue 都改用它暴露的 isDark）
- <NConfigProvider> 直接绑定 useTheme 返回值（naiveTheme + naiveOverrides）
- watch fontSize 保留（业务逻辑，非主题）
- naiveOverrides 迁移到各主题文件，每个主题自带完整的 Naive UI 覆写
```

### `tokens.css` 的去留 / 初始化时序

- **保留** `tokens.css` 作为 fallback/初始值层，定义所有变量的**默认值**。fallback 值 = `glass-industrial-dark` 的 token 值，确保 `useTheme` 应用变量前首屏与目标一致、不闪烁。
- **新增** `src/styles/base.css` — 抽取与主题无关的基础样式：`box-sizing`、`html/body/#app 100%`、滚动条、`.n-config-provider { height: 100% }`（详见记忆 [[naive-config-provider-height-chain]] —— 这条 height 修复**不可漏**，否则高度链再次断开）。这些不随主题变。
- **⚠️ 应用时机必须在 `main.ts` 中 `createApp` 之前同步执行**，不要等 `onMounted`：
  - `applyTokens()` 导出为纯函数（不依赖组件实例），在 `main.ts` 里 `createApp(App).use(...)` 之前、读取 localStorage 持久化值后，**同步**对 `document.documentElement` 应用一次首帧变量；之后 `useTheme` 内部的 `watch(..., { immediate: true })` 接管后续切换。
  - `main.ts` 还会处理旧格式迁移：`theme: 'light'` → `glass-industrial-light`、`theme: 'dark'` → `glass-industrial-dark`。
  - `tokens.css` 的 fallback 与 `main.ts` 首帧指向同一默认值，二者一致即可零闪烁。

## 主题切换流程

```
用户选择主题 "oled-hud"
  → useTheme.setTheme('oled-hud')
  → settingsStore.settings.themeId 更新
  → watch 触发
    → getTheme('oled-hud') → applyTokens(tokens, isDark=true)
    → document.documentElement.style.setProperty(k, v) for each token
    → document.documentElement.setAttribute('data-theme', 'dark')
  → theme computed 更新 → isDark = true
  → naiveTheme = darkTheme, naiveOverrides = oledHud 的覆写
  → <NConfigProvider> 响应式接收新值
  → 所有 Naive UI 组件 + var() 引用同时更新
```

整个切换过程无路由跳转、无页面重载、无组件重挂载 — 纯 CSS 变量覆盖 + Naive UI 响应式。

## 验证方式

1. 启动 `npm run dev`，确认首屏**无闪烁**（首帧即默认主题 `glass-industrial-dark`）
2. 在浏览器 console 调用 `window.__theme.setTheme('oled-hud')` 切换主题
3. 再切到 `window.__theme.setTheme('glass-industrial-light')` 确认亮色正常
4. 确认 wave 波形（uPlot）随主题切换重建配色正常 —— WaveformChart 改用 `useTheme().isDark` 后 `watch(isDark)` 仍触发 `rebuild()`
5. 点设置「恢复默认」，确认主题回到 `DEFAULTS.themeId = 'glass-industrial-dark'`
6. 在 `autoSave=off` 下切换主题，确认主题不落盘（统一走 settings store 的 autoSave 开关）
7. 确认三个主题下所有组件样式正常（消息列表、输入框、弹窗、设置面板等）
8. 确认 `npm run build` 无类型错误（含 `ThemeTokens` 拼写校验）
9. 确认 `npm test` 通过

> `window.__theme` 调试钩子：`useTheme` 内部把 `{ setTheme, themeId, isDark, tokens }` 挂到 `window.__theme`，**仅 dev 环境**（`import.meta.env.DEV`）暴露，避免污染生产。

## 迁移（settings store 字段演进）

当前 `AppSettings` 的 `theme` 字段（`'dark'|'light'`）替换为 `themeId`（`'glass-industrial-dark' | 'glass-industrial-light' | 'oled-hud' | ...`）。

**字段演进**：
```ts
// types.ts AppSettings
// 旧：
//   theme: 'dark' | 'light'
// 新：
  themeId: string            // 'glass-industrial-dark' | 'glass-industrial-light' | 'oled-hud' | …
```

- `DEFAULTS`：`themeId: 'glass-industrial-dark'`（与当前默认行为一致）。
- 迁移已持久化的旧配置（settings store 初始化时处理）：
  - **一代迁移**：`theme: 'dark'|'light'` → `themeId: 'glass-industrial-dark'|'glass-industrial-light'`
  - **二代迁移**：`themeMode: 'dark'|'light'`（中间态）→ 同上
  - **三代迁移**：`themeId: 'glass-industrial'`（无后缀）→ `'glass-industrial-dark'`
- `reset()`：走 `Object.assign(settings, DEFAULTS)`，主题随之回到默认 —— 无需在 useTheme 另加重置逻辑。
- `autoSave`：`themeId` 作为 settings 字段，自动遵循 autoSave 开关，不再绕过。
- `useStorage` 抽象继续适用 —— 阶段2 切到 electron-store 时零改动。

**`useIsDark` 删除而非保留**：迁移时彻底删除 `useIsDark.ts`，其两个消费者（App.vue、WaveformChart.vue）都改用 `useTheme().isDark`。

## 设计决策：为何不再有「跟随系统」

提交 `4074a03` 删除了 `'system'` 选项。这不是为简化而简化，而是**进入多主题世界后，「跟随系统」不再有自明的正确行为**。

- **旧模型**：主题 = 明暗二选一，「跟随系统」只切那个一维量，语义清晰。
- **新模型**：多个主题各有自己的明暗属性。用户选了 `oled-hud` 又开「跟随系统」：系统切亮色时该显示什么？OLED HUD 是暗色主题，没有对应的亮色版本。

**选 D 的理由**：本工具是桌面常驻的串口调试软件，用户多长期固定一种主题；与其勉强定义一个在偏科主题上会露出难看态的「跟随系统」行为，不如让用户从平坦列表中直接选择。代价是失去「跟随系统」能力——在偏科主题普遍存在、且亮/暗是独立主题文件的前提下，这个选项本就不该保留。

**演进路径（不要现在实现）**：将来若需要「跟随系统」，可加回 `themeMode` 字段 + `matchMedia` 解析，让系统根据当前时间自动在暗色/亮色主题间切换。当前不需要。

## 默认主题

`DEFAULTS.themeId = 'glass-industrial-dark'`，`tokens.css` fallback 使用 glass-industrial 暗色值。零行为变更、零迁移动作、首屏天然零闪烁。

## 文件变更汇总

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/themes/types.ts` | ThemeDefinition 接口 + `TOKEN_KEYS`/`TokenKey` 联合（拼写校验） |
| **新建** | `src/themes/registry.ts` | 注册表 + `applyTokens`（纯函数，供 main.ts 首帧调用 + useTheme 切换调用） |
| **新建** | `src/themes/builtin/glass-industrial-dark.ts` | 现有 GitHub-dark 玻璃工业风（暗色） |
| **新建** | `src/themes/builtin/glass-industrial-light.ts` | 玻璃工业风（亮色） |
| **新建** | `src/themes/builtin/oled-hud.ts` | Cyberpunk 终端 HUD 风格（暗色，偏科） |
| **新建** | `src/themes/index.ts` | 统一导出 |
| **新建** | `src/composables/useTheme.ts` | 主题 composable（isDark 来自 theme.isDark + dev 挂 `window.__theme`） |
| **修改** | `src/types.ts` | `AppSettings.theme` → `themeId`；删除 `ThemeMode` 类型 |
| **修改** | `src/stores/settings.ts` | DEFAULTS 增 `themeId`；初始化做旧→新字段迁移（三代）；reset/autoSave 自动覆盖 |
| **删除** | `src/composables/useIsDark.ts` | 能力并入 useTheme；两个消费者改用 `useTheme().isDark` |
| **修改** | `src/App.vue` | 用 useTheme 替代 useIsDark + 手动 naiveTheme/overrides + data-theme watch；naiveOverrides 迁到主题数据 |
| **修改** | `src/components/WaveformChart.vue` | `useIsDark()` → `useTheme()`，`watch(isDark)` 仍 rebuild uPlot 配色 |
| **修改** | `src/components/SettingsModal.vue` | 主题选择从 `s.theme` 改为 `s.themeId`，选项从 `listThemes()` 生成 |
| **修改** | `src/main.ts` | createApp 前同步调用 `applyTokens()` 应用首帧，避免闪烁；处理旧格式迁移 |
| **修改** | `src/styles/tokens.css` | fallback 值对齐默认主题暗色；抽取非主题样式到 base.css（保留 `.n-config-provider { height:100% }` 这条，见 [[naive-config-provider-height-chain]]） |
| **新建** | `src/styles/base.css` | 与主题无关的基础样式（box-sizing / html,body,#app 100% / 滚动条 / NConfigProvider height fix） |
| **无需改** | 除 WaveformChart 外的 `src/components/*.vue` | 其余组件零改动 — 只消费 var() 和 Naive UI props |
