import type { ThemeDefinition } from '@/themes/types'

/**
 * Mondrian 构成 — 蒙德里安几何抽象风。单态亮色。
 * 白画布 + 黑色格线 + 红黄蓝三原色色面（取自《红黄蓝构成》系常用的提取值：
 * 红 #DD0100 / 蓝 #225095 / 黄 #FACA15 / 黑 #0F0F0F / 画布 #F7F5F0）。
 * 0 圆角 + 2px 黑边框 + 硬偏移阴影（无模糊），彩色只作为「色面」出现在
 * RX/TX 气泡、按钮、高亮等块面上；黄色在白底上做文字/细线一律加深为琥珀
 * （#9A6700/#B8860B），保证可读性。形状强制见 styles/themes/mondrian.css。
 */
export const mondrian: ThemeDefinition = {
  id: 'mondrian',
  name: 'Mondrian 构成',
  description: '蒙德里安几何构成（亮色），白画布黑格线 + 红黄蓝三原色色面',
  isDark: false,
  tokens: {
    '--bg': '#F7F5F0',
    '--bg-panel': '#FFFFFF',
    '--bg-elevated': '#F3F0E8',
    '--border': '#0F0F0F',
    '--text': '#0F0F0F',
    '--text-dim': '#6B675F',
    '--accent': '#225095',
    // 三个视图 tab 色取三原色的可读变体：终端=亮蓝、波形=琥珀（黄加深）、仪表盘=红
    '--accent-cyan': '#2E63B4',
    '--accent-teal': '#B8860B',
    '--accent-violet': '#DD0100',
    '--ok': '#225095',
    '--warn': '#9A6700',
    '--err': '#DD0100',
    // RX/TX 气泡 = 蒙德里安色面：淡彩平面 + 黑边框；文字必须近黑（气泡正文即此色）
    '--rx-bg': '#E7EDF8',
    '--rx-border': '#0F0F0F',
    '--rx-text': '#0F0F0F',
    '--tx-bg': '#FBF2CE',
    '--tx-border': '#0F0F0F',
    '--tx-text': '#0F0F0F',
    '--glass-bg': '#FFFFFF',
    '--glass-border': '#0F0F0F',
    '--glass-highlight': '#FFFFFF',
    '--glass-blur': '0px',
    '--glass-blur-sm': '0px',
    // 硬偏移阴影（无模糊）：色面浮起靠位移不靠光晕
    '--shadow-sm': '2px 2px 0 rgba(15, 15, 15, 0.18)',
    '--shadow-md': '3px 3px 0 rgba(15, 15, 15, 0.35)',
    '--shadow-lg': '5px 5px 0 rgba(15, 15, 15, 0.35)',
    '--radius': '0px',
    '--radius-sm': '0px',
    '--radius-md': '0px',
    '--radius-lg': '0px',
    '--radius-xl': '0px',
    '--pill-radius': '0px',
    '--border-width': '2px',
    '--chat-bg': 'var(--bg-panel)',
    '--gap': '8px',
    '--mono-font': "'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', monospace",
    '--ui-font': "'Inter', -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    '--display-font': "'Inter', -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    '--display-letter-spacing': '0',
    '--ascii-btn-font': "'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', monospace",
    '--search-highlight-bg': '#FACA15',
    '--search-highlight-text': '#0F0F0F',
    '--search-active-bg': '#DD0100',
    '--search-active-text': '#FFFFFF',
  },
  // 终端视口：白底黑字红光标，ANSI 以 GitHub Light（亮底可读）为基，
  // red/blue/yellow 三键换成蒙德里安原色的可读变体（黄同 --warn 加深）
  terminal: {
    background: '#FFFFFF',
    foreground: '#0F0F0F',
    cursor: '#DD0100',
    cursorAccent: '#FFFFFF',
    selectionBackground: 'rgba(34, 80, 149, 0.22)',
    black: '#0F0F0F',
    red: '#DD0100',
    green: '#116329',
    yellow: '#9A6700',
    blue: '#225095',
    magenta: '#8250DF',
    cyan: '#1B7C83',
    white: '#6E7781',
    brightBlack: '#57606A',
    brightRed: '#B00000',
    brightGreen: '#1A7F37',
    brightYellow: '#B58200',
    brightBlue: '#2E63B4',
    brightMagenta: '#A475F9',
    brightCyan: '#3192AA',
    brightWhite: '#8C959F',
  },
  naiveOverrides: {
    common: {
      primaryColor: '#225095',
      primaryColorHover: '#2E63B4',
      primaryColorPressed: '#1A3D73',
      primaryColorSuppl: '#2E63B4',
      infoColor: '#225095',
      infoColorHover: '#2E63B4',
      infoColorPressed: '#1A3D73',
      infoColorSuppl: '#2E63B4',
      successColor: '#225095',
      successColorHover: '#2E63B4',
      successColorPressed: '#1A3D73',
      successColorSuppl: '#2E63B4',
      errorColor: '#DD0100',
      errorColorHover: '#EF3B3B',
      errorColorPressed: '#B00000',
      errorColorSuppl: '#EF3B3B',
      warningColor: '#9A6700',
      warningColorHover: '#B58200',
      warningColorPressed: '#7A5700',
      warningColorSuppl: '#B58200',
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
      menuBoxShadow: '4px 4px 0 #0F0F0F',
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
