import type { TerminalPalette, ThemeDefinition } from './types'

/**
 * 主题 → 终端（xterm）配色的解析。
 * xterm 渲染不走 CSS 变量（DOM/canvas 自绘），所以终端配色是主题定义里
 * 与 tokens 并行的 JS 侧数据（ThemeDefinition.terminal），此处补齐缺省键。
 */

/** 经典 xterm 16 色——明暗底均可读，作为未指定 ANSI 键时的兜底 */
const BASELINE_ANSI: Pick<
  TerminalPalette,
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
> = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
}

const DARK_BASE: TerminalPalette = {
  background: '#10151b',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#10151b',
  selectionBackground: 'rgba(230, 237, 243, 0.25)',
  ...BASELINE_ANSI,
}

const LIGHT_BASE: TerminalPalette = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(36, 41, 47, 0.18)',
  ...BASELINE_ANSI,
}

/** 主题 → 完整终端调色板（selectionForeground 之外的键全部就位，可直接赋
 *  term.options.theme；选区文字色留空 = xterm 默认保留原文字色）。
 *  主题自己的 terminal 键优先，缺省键按 isDark 回落基线。纯函数。 */
export function resolveTerminalPalette(def: ThemeDefinition): TerminalPalette {
  return { ...(def.isDark ? DARK_BASE : LIGHT_BASE), ...def.terminal }
}
