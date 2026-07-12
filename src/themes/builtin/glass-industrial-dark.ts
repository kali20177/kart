import type { ThemeDefinition } from '../types'

/**
 * Glass Industrial 暗色 — GitHub-dark 玻璃工业风。
 */
export const glassIndustrialDark: ThemeDefinition = {
  id: 'glass-industrial-dark',
  name: 'Glass Industrial 暗色',
  description: 'GitHub-dark 玻璃工业风（暗色），带毛玻璃和圆角',
  isDark: true,
  tokens: {
    '--bg': '#0d1117',
    '--bg-panel': '#161b22',
    '--bg-elevated': '#1c2333',
    '--border': '#21262d',
    '--text': '#e6edf3',
    '--text-dim': '#8b949e',
    '--accent': '#58a6ff',
    '--accent-cyan': '#22d3ee',
    '--accent-teal': '#14b8a6',
    '--rx-bg': 'rgba(56, 139, 253, 0.12)',
    '--rx-border': 'rgba(56, 139, 253, 0.30)',
    '--rx-text': '#e6edf3',
    '--tx-bg': 'rgba(16, 185, 129, 0.12)',
    '--tx-border': 'rgba(16, 185, 129, 0.30)',
    '--tx-text': '#e6edf3',
    '--ok': '#50c878',
    '--warn': '#f0a850',
    '--err': '#ec5b5b',
    '--search-highlight-bg': '#665a00',
    '--search-highlight-text': '#ffe066',
    '--search-active-bg': '#a85c00',
    '--search-active-text': '#ffe066',
    '--glass-bg': 'rgba(22, 27, 34, 0.75)',
    '--glass-border': 'rgba(255, 255, 255, 0.08)',
    '--glass-blur': '12px',
    '--glass-blur-sm': '8px',
    '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
    '--shadow-md': '0 4px 6px rgba(0, 0, 0, 0.3), 0 2px 4px rgba(0, 0, 0, 0.2)',
    '--shadow-lg': '0 10px 15px rgba(0, 0, 0, 0.4), 0 4px 6px rgba(0, 0, 0, 0.2)',
    '--radius': '6px',
    '--radius-sm': '4px',
    '--radius-md': '6px',
    '--radius-lg': '8px',
    '--radius-xl': '10px',
    '--gap': '8px',
    '--mono-font': "'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', monospace",
    '--ui-font': "'Inter', -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  naiveOverrides: {
    common: {
      primaryColor: '#58a6ff',
      primaryColorHover: '#79c0ff',
      primaryColorPressed: '#388bfd',
      borderRadius: '6px',
    },
    Button: {
      borderRadiusTiny: '4px',
      borderRadiusSmall: '6px',
      borderRadiusMedium: '6px',
    },
    Input: {
      borderRadius: '6px',
    },
    Select: {
      menuBoxShadow: '0 10px 15px rgba(0,0,0,0.4), 0 4px 6px rgba(0,0,0,0.2)',
    },
    Tag: {
      borderRadius: '4px',
    },
  },
}
