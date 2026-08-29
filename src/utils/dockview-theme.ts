import type { DockviewTheme } from 'dockview-vue'

/**
 * dockview 显式主题。
 *
 * dockview 在未传 theme 时会默认给 shell 挂上内置的 abyss 暗色主题类
 * （dockview-core: `theme = options.theme ?? themeAbyss`），整族 abyss 规则以
 * 更高特异性压在 DOM 上——曾有亮色主题下「非激活组 × 非激活 tab」露出
 * #10192c 暗底的事故（abyss 变量经 .dv-shell 下渗，dockview.css 按键覆盖
 * 漏掉一个就漏一块）。因此两个 DockviewVue 实例都必须显式传本主题：
 * 只提供命名类位、不带任何内置配色，配色全部由 src/styles/dockview.css
 * 的 --dv-* 变量族按应用主题提供。
 */
export function createKartDockTheme(isDark: boolean): DockviewTheme {
  return {
    name: 'kart',
    className: 'dockview-theme-kart',
    colorScheme: isDark ? 'dark' : 'light',
  }
}
