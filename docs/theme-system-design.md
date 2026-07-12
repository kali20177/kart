# 主题模块架构设计

## Context

当前项目只有暗色/亮色切换（`data-theme="dark|light"`），修改 `tokens.css` 就会永久丢失原有风格。需要设计一个**开发者友好的主题模块系统**，使多个主题可共存、可切换，主题与业务逻辑完全解耦。

核心原则：
- **组件不感知主题** — 组件只消费 `var(--xxx)` CSS 变量和 Naive UI props，不 import 主题文件
- **主题是纯数据** — 每个主题是一个导出 `ThemeDefinition` 对象的 TS 模块，零逻辑
- **切换原子性** — 运行时切换主题时，所有视觉层（CSS 变量 + Naive UI 覆写）同步更新
- **现有风格保留** — 当前 GitHub-dark 玻璃工业风作为 `glass-industrial` 主题保留

## 涉及的所有 CSS 变量（已按「实际消费 / 仅定义」区分，以 `grep -oE 'var\(--[a-z0-9-]+\)' src/components src/App.vue` 校准）

> 标注「✅消费」表示存在 `var(--xxx)` 消费者；「仅定义」表示只在 `tokens.css` 里设值、无消费者。提取 `glass-industrial.ts` 时两者都要带上（仅定义的可一并迁移以免将来消费时漏值），但要知道当前视觉只依赖前者。`--bubble-font-size` 非主题变量，不纳入。

| 类别 | 变量 | 用途 | 状态 |
|------|------|------|------|
| 背景层级 | `--bg`, `--bg-panel`, `--bg-elevated` | 页面底 → 面板 → 抬高 | ✅消费 |
| 文本层级 | `--text`, `--text-dim` | 主文字 / 次级文字 | ✅消费 |
| 边框 | `--border` | 所有边框分隔线 | ✅消费 |
| 强调色 | `--accent` | 主强调 | ✅消费 |
| 强调色 | `--accent-cyan`, `--accent-teal` | 青色/蓝绿辅助 | 仅定义（tokens.css 有，但全项目无 `var()` 消费者 —— 主题文件里可保留为占位/备用） |
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
  types.ts                 # ThemeDefinition 接口 + 类型
  registry.ts              # 主题注册表 + 工具函数
  builtin/
    glass-industrial.ts    # 现有 GitHub-dark 玻璃工业风（保留）
    oled-hud.ts            # 新 Cyberpunk 终端 HUD 风格
  index.ts                 # 统一导出
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

/** 单色模式（light/dark）的全部 CSS 自定义属性 —— 拼写错误的 key 会在 vue-tsc 报错 */
export type ThemeTokens = Partial<Record<TokenKey, string>>

/** 一个完整主题定义 */
export interface ThemeDefinition {
  id: string
  name: string
  description?: string
  /** 亮/暗两套 CSS 变量。两态皆可选 —— 允许「单态偏科主题」只填一个态
   *  （如 oled-hud 只真做 dark），缺省态由 useTheme 自动回退到另一套，
   *  避免 `跟随系统`/切亮色时落到凑数难看的态（见「设计决策」语义 D）。 */
  tokens: Partial<{
    light: ThemeTokens
    dark: ThemeTokens
  }>
  /** Naive UI 主题覆写（可选，缺省用 Naive UI 默认） */
  naiveOverrides?: {
    light?: GlobalThemeOverrides
    dark?: GlobalThemeOverrides
  }
  /** Google Fonts 等外部字体 URL（可选）。注入策略见下方「字体注入」注释 */
  fonts?: string[]
}
```

- `ThemeTokens` 用 `Partial<Record<TokenKey, string>>` —— 几乎零额外抽象，却把拼写错误挡在 `vue-tsc` 之前；相比裸 `Record<string, string>`，`--raduis` 这种笔误会在类型检查期暴露，避免切主题后某组件静默用回 fallback。`Partial` 允许主题只覆盖关心的变量，未覆盖的回退到 `tokens.css` 默认值。
- 每个主题文件只导出一个 `ThemeDefinition` 对象，纯数据，无逻辑。

> **字体注入（fonts）**：`fonts` 是 Google Fonts 等外链 `<link rel="stylesheet">`。`useTheme` 切主题时需负责：
> 1. 把上一主题注入的 `<link data-theme-font>` 从 `<head>` 移除；
> 2. 把新主题 `fonts` 数组逐条创建为 `<link>` 加回，加 `data-theme-font` 标记便于下次移除。
>
> **CSP / 离线约束**（见记忆 [[i18n-must-precompile-csp]]）：当前项目 CSP 禁 `unsafe-eval`（i18n 已为它改用预编译），外链字体要求 CSP 放行 `style-src`/`font-src` 到 `fonts.googleapis.com`/`fonts.gstatic.com`；Electron 生产环境默认离线，外链字体不会加载 → 主题必须把 fallback 字体栈写在 `--mono-font`/`--ui-font` 里（HUD 示例已做到：`--ui-font` 以 `'Inter',-apple-system...` 开头，Orbitron 加载失败时回退到 sans-serif）。结论：`fonts` 仅作锦上添花，**绝不能让视觉依赖外链字体是否加载成功**。

### 主题注册表 — `src/themes/registry.ts`

```ts
import type { ThemeDefinition } from './types'
import { glassIndustrial } from './builtin/glass-industrial'
import { oledHud } from './builtin/oled-hud'

const registry = new Map<string, ThemeDefinition>()

// 内置主题注册
register(glassIndustrial)
register(oledHud)

export function register(theme: ThemeDefinition): void { ... }
export function getTheme(id: string): ThemeDefinition | undefined { ... }
export function listThemes(): ThemeDefinition[] { ... }
```

注册表是 `Map<string, ThemeDefinition>`，`register()` 幂等（后注册覆盖同 ID）。

### Composable — `src/composables/useTheme.ts`（新建）

核心逻辑，替代当前 `useIsDark` + `App.vue` 中分散的主题逻辑。

> **明暗维度采用二元 `'light' | 'dark'`，无 `system`**（语义 D，见下方「设计决策：为何不再有『跟随系统』」）。提交 `4074a03` 已把 `ThemeMode` 收敛为 `'light'|'dark'`、删除 settings/loci/ui 里的 `system` 选项与 `useIsDark` 的 `matchMedia` 解析。本模块只需沿用这一现状，**不要再加回 `system`**。

```ts
export function useTheme() {
  // 状态 —— 纳入 settings store，由 store 统一持久化/重置/受 autoSave 控制
  // 必须从 settings store 读取（见「迁移」），不要另开 localStorage key
  const settingsStore = useSettingsStore()
  const themeId = computed<string>(() => settingsStore.settings.themeId)
  const mode = computed<'light' | 'dark'>(() => settingsStore.settings.themeMode)

  // 派生（二元，无 system 解析）
  const theme = computed(() => getTheme(themeId.value))
  const isDark = computed(() => mode.value === 'dark')
  // 主题可能势单态偏科（见设计决策）：若该主题无对应 token 套，回退到另一套，
  // 避免跟随 mode 切到凑数难看的态。tokens 由「目标 mode + 主题是否提供该态」决定。
  const tokens = computed(() => {
    const t = theme.value
    if (!t) return {}
    const want = isDark.value ? t.tokens.dark : t.tokens.light
    const fallback = isDark.value ? t.tokens.light : t.tokens.dark
    return Object.keys(want ?? {}).length ? want! : (fallback ?? {})
  })
  const naiveTheme = computed(() => isDark.value ? darkTheme : null)
  const naiveOverrides = computed(() => {
    const t = theme.value?.naiveOverrides
    return isDark.value ? t?.dark : t?.light
  })

  // 副作用：应用 CSS 变量到 :root。运行时机见「初始化时序」——
  // 首次应用必须在 main.ts createApp 前同步执行，不要等 onMounted，否则首屏闪烁。
  watch([themeId, mode], () => applyTokens(tokens.value), { immediate: true })

  // setter 直接写 settings store（走 store 的持久化/autoSave/reset 语义）
  function setTheme(id: string) { settingsStore.settings.themeId = id }
  function setMode(m: 'light' | 'dark') { settingsStore.settings.themeMode = m }

  return { themeId, mode, isDark, naiveTheme, naiveOverrides, setTheme, setMode, listThemes }
}
```

> **`isDark` 的外部消费者**：`src/components/WaveformChart.vue` 当前用 `useIsDark()` 的 `isDark`（`watch(isDark, () => rebuild())`，因为 uPlot canvas 不吃 CSS 变量，需 JS 读 computed style 重建）。迁移后 `useIsDark` 删除，WaveformChart 改用 `useTheme().isDark` —— 这是 `useTheme` 必须暴露稳定 `isDark`（而非只暴露 `mode`）的原因。`useTheme` 替代 `useIsDark` 的全部两个消费者（App.vue + WaveformChart）。

**`applyTokens()` 实现**：遍历 `tokens` 对象，逐项 `document.documentElement.style.setProperty(key, value)`。同时设置 `data-theme="dark|light"` 属性保持兼容。需导出独立函数并支持脱离组件上下文调用（供 `main.ts` 在 createApp 前同步执行首帧应用）。

### 主题文件示例 — `src/themes/builtin/oled-hud.ts`

```ts
import type { ThemeDefinition } from '../types'

export const oledHud: ThemeDefinition = {
  id: 'oled-hud',
  name: 'OLED HUD',
  description: 'Cyberpunk 终端风格，OLED 暗色 + 霓虹绿/青/琥珀',
  fonts: [
    'https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap'
  ],
  tokens: {
    dark: {
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
      '--radius-lg': '3px',
      '--radius-xl': '4px',
      // 字体
      '--mono-font': "'JetBrains Mono','Cascadia Mono','Consolas',monospace",
      '--ui-font': "'Inter',-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
      // 搜索高亮
      '--search-highlight-bg': '#1A3D1A',
      '--search-highlight-text': '#00FF88',
      '--search-active-bg': '#2D5A1E',
      '--search-active-text': '#00FF88',
    },
    light: {
      // ... 亮色对应值（浅灰底 + 深绿强调）
    }
  },
  naiveOverrides: {
    dark: {
      common: {
        primaryColor: '#00E676',
        primaryColorHover: '#33FF99',
        primaryColorPressed: '#00C853',
        borderRadius: '2px',
      },
      // Button, Input, Select, Tag 等组件 borderRadius 统一 2px
    },
    light: { /* ... */ }
  }
}
```

关键设计：`--glass-bg` 等在 HUD 主题中映射为实色（`#0A0A0F`），组件 CSS 里 `var(--glass-bg)` 照用不误，但视觉效果变为无毛玻璃的实色面板。主题切换对组件完全透明。

### `App.vue` 简化

**Before（当前）**：
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
- ⚠️ naiveOverrides 迁移：当前 themeOverrides 含 primaryColor/primaryColorHover/primaryColorPressed（按 isDark 三元）、Select.menuBoxShadow（按 isDark 三元）、Button/Input/Tag borderRadius 等硬编码。落到「纯数据主题」后，**按各主题实际提供的明暗态逐一搬**——双态主题（如 glass-industrial 亮/暗都用心做）需要 `naiveOverrides.light`+`naiveOverrides.dark` 两套；单态偏科主题（如 oled-hud 只真做暗色）只需 `naiveOverrides.dark`，亮态留空让 `useTheme.naiveOverrides` 在用户切亮色时回退。因此不是「一文件」工作量，要按主题盘点哪些态真有视觉投入、相应填齐，避免凑数态下控件样式退化。
```

### `tokens.css` 的去留 / 初始化时序

- **保留** `tokens.css` 作为 fallback/初始值层，定义所有变量的**默认值**。关键决策：fallback 值应等于**默认主题的暗色值**（默认主题是什么，见「迁移 ▸ 默认主题决策」），确保 `useTheme` 应用变量前首屏与目标一致、不闪烁。
- **新增** `src/styles/base.css`（可选）— 抽取与主题无关的基础样式：`box-sizing`、`html/body/#app 100%`、滚动条、`.n-config-provider { height: 100% }`（详见记忆 [[naive-config-provider-height-chain]] —— 这条 height 修复**不可漏**，否则高度链再次断开）、NConfigProvider height fix。这些不随主题变。
- **⚠️ 应用时机必须在 `main.ts` 中 `createApp` 之前同步执行**，不要等 `onMounted`：
  - 旧方案说「`applyTokens()` 在 `onMounted` 时运行」+ 默认主题又是 `oled-hud`，而 `tokens.css` fallback 若保留为 glass-industrial 暗色值 → 首屏必然是 glass-industrial 暗色，`onMounted` 后跳 oled-hud，**肉眼可见闪烁**，与「确保初始化前不闪烁」自相矛盾。
  - 正确做法：`applyTokens()` 导出为纯函数（不依赖组件实例），在 `main.ts` 里 `createApp(App).use(...)` 之前、读取 settings store 持久化值后，**同步**对 `document.documentElement` 应用一次首帧变量；之后 `useTheme` 内部的 `watch(..., { immediate: true })` 接管后续切换。`tokens.css` 的 fallback 与 `main.ts` 首帧尽量指向同一默认值，二者一致即可零闪烁。

## 主题切换流程

```
用户选择主题 "oled-hud"
  → useTheme.setTheme('oled-hud')
  → themeId ref 更新
  → tokens computed 重新计算 → { '--bg': '#050508', ... }
  → watch 触发 applyTokens()
    → for each [k, v]: document.documentElement.style.setProperty(k, v)
  → naiveTheme / naiveOverrides computed 更新
  → <NConfigProvider> 响应式接收新值
  → 所有 Naive UI 组件 + var() 引用同时更新
```

整个切换过程无路由跳转、无页面重载、无组件重挂载 — 纯 CSS 变量覆盖 + Naive UI 响应式。

## 验证方式

1. 启动 `npm run dev`，确认首屏**无闪烁**（首帧即默认主题，无 glass→oled 跳变）
2. 在浏览器 console 调用 `window.__theme.setTheme('glass-industrial')` 切换主题、`window.__theme.setMode('light')` 切亮色
3. 切到仅暗态主题（如将来的 oled-hud）后再切 `mode='light'`，确认 `tokens` 回退到该主题暗色套而非空白（单态偏科回退逻辑生效）
4. 确认 wave 波形（uPlot）随明暗切换重建配色正常 —— WaveformChart 改用 `useTheme().isDark` 后 `watch(isDark)` 仍触发 `rebuild()`
5. 点设置「恢复默认」，确认主题与明暗一并回到 `DEFAULTS`（而非主题不变、明暗变错）
6. 在 `autoSave=off` 下切换主题，确认主题不落盘（统一走 settings store 的 autoSave 开关）
7. 确认两个主题下所有组件样式正常（消息列表、输入框、弹窗、设置面板等）
8. 确认 `npm run build` 无类型错误（含 `ThemeTokens` 拼写校验）
9. 确认 `npm test` 通过（如有主题相关测试）

> `window.__theme` 调试钩子需显式挂载：`useTheme` 内部（或 `main.ts`）把 `{ setTheme, setMode }` 挂到 `window.__theme`，**仅 dev 环境**（`import.meta.env.DEV`）暴露，避免污染生产。

## 迁移（settings store 字段演进）

当前 [src/stores/settings.ts](src/stores/settings.ts) 的 `AppSettings.theme` 是 `'dark'|'light'`（提交 `4074a03` 已删除 `'system'`，类型见 [src/types.ts](src/types.ts) 的 `ThemeMode = 'light' | 'dark'`），由 settings store 统一持久化（`localStorage['settings']`）、受 `autoSave` 开关控制、`reset()` 回到 `DEFAULTS.theme='dark'`。主题模块的 `themeId`+`mode` **必须并入此体系**，不要另开 localStorage key（否则持久化/重置/autoSave 三套语义分裂 —— reset 不重置主题、autoSave=off 时主题照写自己的 key 绕过用户意图）。

**字段演进**：
```ts
// types.ts AppSettings
// 现（提交 4074a03 后）：
//   theme: 'dark' | 'light'
// 主题模块落地后：
  themeId: string            // 'glass-industrial' | 'oled-hud' | …
  themeMode: 'light' | 'dark'   // 二元，无 system（语义 D）
```
- `DEFAULTS`：`themeId: <默认主题>`, `themeMode: 'dark'`（与当前默认行为一致）。
- 迁移已持久化的旧配置：settings store 初始化时若读到旧 `theme` 字段、没有新字段，映射 `themeMode = oldTheme`（`'dark'/'light'` 直接对应；`'system'` 不可能再出现，若读到历史数据疑似 `'system'` 兜底当作 `'dark'`）、`themeId = 'glass-industrial'`（等效于旧风格），并写回新字段、删旧字段。
- `reset()`：走 `Object.assign(settings, DEFAULTS)`，主题/模式随之回到默认 —— 无需在 useTheme 另加重置逻辑。
- `autoSave`：`themeId`/`themeMode` 作为 settings 字段，自动遵循 autoSave 开关，不再绕过。
- `useStorage` 抽象继续适用 —— 阶段2 切到 electron-store 时零改动。

**`useIsDark` 删除而非保留**：迁移时彻底删除 [useIsDark.ts](src/composables/useIsDark.ts)（提交 `4074a03` 后它已退化为单行 `settings.theme === 'dark'`，并入 `useTheme` 无信息损失），其两个消费者（App.vue、[WaveformChart.vue](src/components/WaveformChart.vue)）都改用 `useTheme().isDark`。若两者并存，`useIsDark` 读 `settings.theme`、`useTheme` 读新 `themeMode`，两套明暗判断会不同步。

## 设计决策：为何不再有「跟随系统」

提交 `4074a03` 删除了 `'system'` 选项。这不是为简化而简化，而是**进入多主题世界后，「跟随系统」不再有自明的正确行为**。

- **旧模型**：主题 = 明暗二选一，「跟随系统」只切那个一维量，语义清晰。
- **新模型**：明暗（`M`）与主题（`T`）是两个独立维度。用户选了 `oled-hud` 又开「跟随系统」：系统切亮色时该显示什么？oled-hud 的亮色套多半是凑的废值（它卖点就是 OLED 暗色 + 霓虹）。四种可能语义各有代价：
  - **A** 跟随系统只定 `M`、`T` 用户自选 → 要求每主题都认真做亮+暗两套，否则撞到凑数难看的态（这是 naiveOverrides 真需 4 套用心填的根因）。
  - **B** 跟随系统只在"主题有对应明暗套"时生效，否则锁单态 → 诚实地允许主题偏科，但类型要支持可选态、`useTheme` 要回退。
  - **C** 跟随系统时连主题槽位都分开配（昼 T1 / 夜 T2）→ 状态膨胀、双选择器，超出本工具所需。
  - **D（本设计）** 砍掉「跟随系统」，明暗与主题都由用户显式选。

**选 D 的理由**：本工具是桌面常驻的串口调试软件，用户多长期固定一种主题；与其勉强定义一个会在偏科主题上露出难看态的「跟随系统」行为，不如让两个维度都显式可控。代价是失去「跟随系统」能力——在偏科主题普遍存在的前提下，这个选项本就不该保留。

**主题偏科的现实**：因此 `ThemeDefinition.tokens` **允许单态一个套为空/缺省**，`useTheme.tokens` 已做回退——目标 mode 无对应套时落到另一套，绝不应用空白。这样 `oled-hud` 可以只真做暗色、`glass-industrial` 亮暗都做，互不强求。

**演进路径（不要现在实现）**：将来若所有主题都认真双态投入了，可按语义 A 把「跟随系统」加回——`mode` 加 `'system'` 一个字面量 + `matchMedia` 解析（即本设计文档早期草拟的版本），不影响主题数据结构。也即 D 不欠债：单态偏科时 D 是对的终态，双态全员投入时 D→A 平滑升级。**当前到 A 之前，不要再加回 `system`。**

## 默认主题决策

`useTheme` 示例里把 `themeId` 默认写 `'oled-hud'`、验证步骤也默认 oled-hud —— 这等于**改换了整个产品的开箱视觉**（当前默认是 glass-industrial / GitHub-dark 玻璃风）。这是产品级决策，不应藏在示例代码里。两种方案择一，请显式确认：

- **方案 A（推荐 / 不改默认）**：`DEFAULTS.themeId = 'glass-industrial'`，`tokens.css` fallback 用 glass-industrial 暗色值，oled-hud 仅作可选风格。零行为变更、零迁移动作、首屏天然零闪烁。
- **方案 B（换默认）**：`DEFAULTS.themeId = 'oled-hud'`，则 `tokens.css` fallback 必须也用 oled-hud 暗色值（否则首屏闪烁见「初始化时序」），且视为一次有意的视觉改版，需同步更新截图/文档。

本文档代码示例恢复为不预设默认值（具体默认由 `DEFAULTS` 决定），避免与方案选择冲突。

## 文件变更汇总

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/themes/types.ts` | ThemeDefinition 接口 + `TOKEN_KEYS`/`TokenKey` 联合（拼写校验） |
| **新建** | `src/themes/registry.ts` | 注册表 + `applyTokens`（纯函数，供 main.ts 首帧调用 + useTheme 切换调用） |
| **新建** | `src/themes/builtin/glass-industrial.ts` | 现有风格的完整 token 提取（含仅定义变量，避免将来漏值） |
| **新建** | `src/themes/builtin/oled-hud.ts` | 新 HUD 风格（偏科暗态：`tokens.dark` + `naiveOverrides.dark` 用心填，亮态留空由 useTheme 回退） |
| **新建** | `src/themes/index.ts` | 统一导出 |
| **新建** | `src/composables/useTheme.ts` | 主题 composable（二元明暗 + 单态主题 token 回退 + dev 挂 `window.__theme`） |
| **修改** | `src/types.ts` | `AppSettings.theme` → `{ themeId, themeMode }`，加入迁移映射 |
| **修改** | `src/stores/settings.ts` | DEFAULTS 增 `themeId`/`themeMode`；初始化做旧→新字段迁移；reset/autoSave 自动覆盖 |
| **删除** | `src/composables/useIsDark.ts` | 能力并入 useTheme；两个消费者改用 `useTheme().isDark` |
| **修改** | `src/App.vue` | 用 useTheme 替代 useIsDark + 手动 naiveTheme/overrides + data-theme watch；naiveOverrides 迁到主题数据 |
| **修改** | `src/components/WaveformChart.vue` | `useIsDark()` → `useTheme()`，`watch(isDark)` 仍 rebuild uPlot 配色 |
| **修改** | `src/main.ts` | createApp 前同步调用 `applyTokens()` 应用首帧，避免闪烁 |
| **修改** | `src/styles/tokens.css` | fallback 值对齐默认主题暗色；抽取非主题样式到 base.css（保留 `.n-config-provider { height:100% }` 这条，见 [[naive-config-provider-height-chain]]） |
| **新建** | `src/styles/base.css` | 与主题无关的基础样式（box-sizing / html,body,#app 100% / 滚动条 / NConfigProvider height fix） |
| **无需改** | 除 WaveformChart 外的 `src/components/*.vue` | 其余组件零改动 — 只消费 var() 和 Naive UI props |
