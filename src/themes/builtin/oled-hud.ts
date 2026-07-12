import type { ThemeDefinition } from '../types'

/**
 * OLED HUD — Cyberpunk 终端风格。单态暗色。
 */
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
    '--rx-bg': 'rgba(0,212,255,0.08)',
    '--rx-border': 'rgba(0,212,255,0.30)',
    '--rx-text': '#E0E0E8',
    '--tx-bg': 'rgba(255,176,0,0.08)',
    '--tx-border': 'rgba(255,176,0,0.30)',
    '--tx-text': '#E0E0E8',
    '--glass-bg': '#0A0A0F',
    '--glass-border': '#1E1E2E',
    '--glass-blur': '0px',
    '--glass-blur-sm': '0px',
    '--shadow-sm': '0 1px 3px rgba(0,0,0,0.5)',
    '--shadow-md': '0 4px 12px rgba(0,0,0,0.5)',
    '--shadow-lg': '0 8px 24px rgba(0,0,0,0.6)',
    '--radius': '2px',
    '--radius-sm': '2px',
    '--radius-md': '2px',
    '--radius-lg': '3px',
    '--radius-xl': '4px',
    '--gap': '8px',
    '--mono-font': "'JetBrains Mono','Cascadia Mono','Consolas',monospace",
    '--ui-font': "'Inter',-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
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
