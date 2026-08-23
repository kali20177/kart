import type { ThemeDefinition } from '../types'

/**
 * Retro Console 像素风 — 复古游戏机配色。单态暗色。
 * 0 圆角 + 2px 硬边框 + 阶梯硬阴影（2px 偏移无模糊），营造像素/CRT 感。
 * 标题用 Press Start 2P（仅 Latin，中文回退 ui-font），数据用 VT323（等宽）。
 */
export const retroConsole: ThemeDefinition = {
  id: 'retro-console',
  name: 'Retro Console 像素',
  description: '复古游戏机像素风（暗色），霓虹青/绿/琥珀 + 硬边框',
  isDark: true,
  tokens: {
    '--bg': '#0D1024',
    '--bg-panel': '#141837',
    '--bg-elevated': '#1B2145',
    '--border': '#2E3A66',
    '--text': '#E8F0FF',
    '--text-dim': '#8899C8',
    '--accent': '#00E5FF',
    '--accent-cyan': '#00E5FF',
    '--accent-teal': '#3DFF8F',
    '--accent-violet': '#FF6EC7',
    '--ok': '#3DFF8F',
    '--warn': '#FFB627',
    '--err': '#FF4D6D',
    '--rx-bg': 'rgba(0, 229, 255, 0.09)',
    '--rx-border': '#00E5FF',
    '--rx-text': '#E8F0FF',
    '--tx-bg': 'rgba(61, 255, 143, 0.09)',
    '--tx-border': '#3DFF8F',
    '--tx-text': '#E8F0FF',
    '--glass-bg': '#141837',
    '--glass-border': '#2E3A66',
    '--glass-highlight': 'rgba(0, 229, 255, 0.55)',
    '--glass-blur': '0px',
    '--glass-blur-sm': '0px',
    '--shadow-sm': '0 2px 0 rgba(0, 0, 0, 0.35)',
    '--shadow-md': '0 4px 0 rgba(0, 0, 0, 0.35)',
    '--shadow-lg': '0 8px 0 rgba(0, 0, 0, 0.35)',
    '--radius': '0px',
    '--radius-sm': '0px',
    '--radius-md': '0px',
    '--radius-lg': '0px',
    '--radius-xl': '0px',
    '--pill-radius': '0px',
    '--border-width': '2px',
    '--chat-bg': 'var(--bg-panel)',
    '--gap': '8px',
    '--mono-font': "'VT323 Local','VT323','Cascadia Mono','Consolas',monospace",
    '--ui-font': "'VT323 Local','VT323','PingFang SC','Microsoft YaHei',monospace",
    '--display-font': "'Press Start 2P Local','Press Start 2P','Inter','PingFang SC',sans-serif",
    '--display-letter-spacing': '1px',
    '--ascii-btn-font': "'Press Start 2P Local','Press Start 2P','Inter','PingFang SC',sans-serif",
    '--search-highlight-bg': '#3A2F10',
    '--search-highlight-text': '#FFE066',
    '--search-active-bg': '#6B4E00',
    '--search-active-text': '#FFE066',
  },
  naiveOverrides: {
    common: {
      primaryColor: '#00E5FF',
      primaryColorHover: '#4DF0FF',
      primaryColorPressed: '#00B8CC',
      primaryColorSuppl: '#00B8CC',
      borderRadius: '0px',
      fontFamily: 'var(--ui-font)',
    },
    Dropdown: {
      fontSizeSmall: '13px',
      fontSizeMedium: '13px',
      optionHeightSmall: '26px',
      optionHeightMedium: '28px',
      optionPrefixWidthSmall: '10px',
      optionPrefixWidthMedium: '10px',
      optionIconPrefixWidthSmall: '24px',
      optionIconPrefixWidthMedium: '24px',
      optionSuffixWidthSmall: '10px',
      optionSuffixWidthMedium: '10px',
      optionIconSuffixWidthSmall: '24px',
      optionIconSuffixWidthMedium: '24px',
    },
    Button: {
      borderRadiusTiny: '0px',
      borderRadiusSmall: '0px',
      borderRadiusMedium: '0px',
      borderRadiusLarge: '0px',
    },
    Input: {
      borderRadius: '0px',
    },
    Select: {
      borderRadius: '0px',
      menuBorderRadius: '0px',
      menuBoxShadow: '0 4px 0 rgba(0, 0, 0, 0.4)',
    },
    Tag: {
      borderRadius: '0px',
    },
    Card: {
      borderRadius: '0px',
    },
    Modal: {
      borderRadius: '0px',
    },
    Popover: {
      borderRadius: '0px',
    },
    Tooltip: {
      borderRadius: '0px',
    },
    Tabs: {
      tabBorderRadius: '0px',
    },
    Slider: {
      railBorderRadius: '0px',
      handleBorderRadius: '0px',
    },
    Checkbox: {
      borderRadius: '0px',
    },
    Radio: {
      radioBorderRadius: '0px',
    },
    Switch: {
      railBorderRadius: '0px',
      buttonBorderRadius: '0px',
    },
    Progress: {
      borderRadius: '0px',
    },
    Dialog: {
      borderRadius: '0px',
    },
  },
}
