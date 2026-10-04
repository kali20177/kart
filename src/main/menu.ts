import { BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { mainLogger } from '@/main/logger'
import type { JsonStore } from '@/main/JsonStore'

/**
 * macOS 原生应用菜单（系统菜单栏）。
 *
 * 为什么 macOS 必须有应用菜单而不能设 null：macOS 的文本编辑快捷键
 * （⌘C/⌘V/⌘X/⌘A）由原生菜单的编辑菜单 role 项派发，渲染层收到裸 keydown
 * 不会自己执行粘贴/拷贝——设 null 会让这些快捷键全部失效（实测证实）。
 * 另外系统菜单栏出现「关于/退出/窗口」等标准入口也符合 HIG 惯例。
 *
 * 自定义动作（导出/录制/新建会话等）不进主进程：click 统一经 'menu:action'
 * IPC 下发给渲染层，由 MenuBar 的 dispatch 走与自绘菜单完全相同的路径。
 * 渲染层经 'menu:update-state' 推送勾选态/录制状态/语言，驱动菜单重建。
 *
 * 注意：编辑菜单刻意不含撤销/重做 role——⌘Z/⌘Y 被菜单拦截后 DOM 收不到
 * keydown，InputComposer 的 HEX 排版撤销栈（自维护，原生撤销栈已被程序化
 * 改写清空）就会失效。ASCII 模式的原生撤销在无菜单时本就不可用，维持现状。
 */

/** 渲染端推送的菜单驱动状态 */
export interface MenuState {
  locale: string
  autoSave: boolean
  /** 快捷命令侧栏是否展开（查看菜单勾选态） */
  quickRailVisible: boolean
  recording: 'idle' | 'recording' | 'stopping' | 'error'
  recordingSupported: boolean
}

/** 菜单动作（与 MenuBar.vue 自绘菜单的 key 完全同名，渲染层统一分发） */
export type MenuAction =
  | 'new-session' | 'close-session'
  | 'export-log' | 'toggle-recording' | 'auto-save' | 'reset-defaults'
  | 'quick-rail' | 'settings' | 'ascii' | 'file-transfer'
  | 'know-base' | 'shortcuts' | 'check-update' | 'about' | 'license'

/** 菜单文案（zh-CN / en）。与渲染层 locales 的 menu.* 同义，主进程独立成典，
 *  避免把整套渲染端 locale 文件打进主进程 bundle；改文案时两处需同步。 */
const STRINGS: Record<string, {
  about: string; checkUpdate: string; settings: string
  hide: string; hideOthers: string; unhide: string; quit: string; services: string
  file: string; newSession: string; closeSession: string; exportLog: string
  startRecording: string; stopRecording: string; autoSave: string; resetDefaults: string
  edit: string; cut: string; copy: string; paste: string; pasteMatch: string; delete: string; selectAll: string
  view: string; quickRail: string; fullscreen: string; devtools: string
  window: string; minimize: string; zoom: string; front: string
  help: string; knowBase: string; shortcuts: string; license: string
}> = {
  'zh-CN': {
    about: '关于', checkUpdate: '检查更新…', settings: '设置…',
    hide: '隐藏', hideOthers: '隐藏其他', unhide: '全部显示', quit: '退出', services: '服务',
    file: '文件', newSession: '新建会话', closeSession: '关闭当前会话', exportLog: '导出日志…',
    startRecording: '开始录制', stopRecording: '停止录制', autoSave: '自动保存配置', resetDefaults: '恢复默认设置…',
    edit: '编辑', cut: '剪切', copy: '拷贝', paste: '粘贴', pasteMatch: '粘贴并匹配样式', delete: '删除', selectAll: '全选',
    view: '查看', quickRail: '快捷命令栏', fullscreen: '进入全屏', devtools: '开发者工具',
    window: '窗口', minimize: '最小化', zoom: '缩放', front: '前置全部窗口',
    help: '帮助', knowBase: '常见问题', shortcuts: '快捷键', license: '许可证',
  },
  en: {
    about: 'About', checkUpdate: 'Check for Updates…', settings: 'Settings…',
    hide: 'Hide', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit', services: 'Services',
    file: 'File', newSession: 'New Session', closeSession: 'Close Current Session', exportLog: 'Export Log…',
    startRecording: 'Start Recording', stopRecording: 'Stop Recording', autoSave: 'Auto Save Config', resetDefaults: 'Restore Defaults…',
    edit: 'Edit', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteMatch: 'Paste and Match Style', delete: 'Delete', selectAll: 'Select All',
    view: 'View', quickRail: 'Quick Commands', fullscreen: 'Enter Full Screen', devtools: 'Developer Tools',
    window: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
    help: 'Help', knowBase: 'Knowledge Base', shortcuts: 'Keyboard Shortcuts', license: 'License',
  },
}

function stringsOf(locale: string): typeof STRINGS['zh-CN'] {
  // 应用内语言只有 zh-CN / en-US 两档（settings.locale），按前缀归档更稳；
  // 意外值回落英文
  return locale.startsWith('zh') ? STRINGS['zh-CN'] : STRINGS.en
}

/** 当前菜单状态（registerMenuIpc 初始 + 渲染端推送更新） */
let menuState: MenuState

function sendMenuAction(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send('menu:action', action)
}

/**
 * 构建 macOS 菜单模板（纯函数，appName 注入便于单测）。
 * role 项承担原生行为与快捷键（⌘C/⌘M/⌘Q 等）；自定义项 label 手写（role 默认
 * label 是英文，中文界面必须覆盖）。
 */
export function buildMacMenuTemplate(state: MenuState, appName: string): MenuItemConstructorOptions[] {
  const s = stringsOf(state.locale)
  const act = (action: MenuAction) => () => sendMenuAction(action)
  return [
    {
      // macOS 首个菜单的 label 恒显示为应用名（系统行为），label 仅为语义完整
      label: appName,
      submenu: [
        { label: `${s.about} ${appName}`, click: act('about') },
        { label: s.checkUpdate, click: act('check-update') },
        { type: 'separator' },
        { label: s.settings, accelerator: 'CmdOrCtrl+,', click: act('settings') },
        { type: 'separator' },
        { role: 'services', label: s.services },
        { type: 'separator' },
        { role: 'hide', label: `${s.hide} ${appName}` },
        { role: 'hideOthers', label: s.hideOthers },
        { role: 'unhide', label: s.unhide },
        { type: 'separator' },
        { role: 'quit', label: `${s.quit} ${appName}` },
      ],
    },
    {
      label: s.file,
      submenu: [
        { label: s.newSession, accelerator: 'CmdOrCtrl+N', click: act('new-session') },
        { label: s.closeSession, click: act('close-session') },
        { type: 'separator' },
        { label: s.exportLog, click: act('export-log') },
        // 录制项标签/可用性与自绘菜单同语义：非 idle 显示「停止」，stopping/不支持禁用
        {
          label: state.recording === 'idle' ? s.startRecording : s.stopRecording,
          enabled: state.recordingSupported && state.recording !== 'stopping',
          click: act('toggle-recording'),
        },
        { label: s.autoSave, type: 'checkbox', checked: state.autoSave, click: act('auto-save') },
        { type: 'separator' },
        { label: s.resetDefaults, click: act('reset-defaults') },
      ],
    },
    {
      label: s.edit,
      submenu: [
        // 刻意无 undo/redo role——见文件头注释（HEX 撤销栈会被 ⌘Z 拦截破坏）
        { role: 'cut', label: s.cut },
        { role: 'copy', label: s.copy },
        { role: 'paste', label: s.paste },
        { role: 'pasteAndMatchStyle', label: s.pasteMatch },
        { role: 'delete', label: s.delete },
        { role: 'selectAll', label: s.selectAll },
      ],
    },
    {
      label: s.view,
      submenu: [
        { label: s.quickRail, type: 'checkbox', checked: state.quickRailVisible, click: act('quick-rail') },
        { type: 'separator' },
        // 不提供 reload/forceReload role：页面重载会残留串口句柄（见 CLAUDE.md 注意事项）
        { role: 'togglefullscreen', label: s.fullscreen },
        { role: 'toggleDevTools', label: s.devtools },
      ],
    },
    {
      label: s.window,
      submenu: [
        // role 默认 label 是英文，中文界面必须显式覆盖（否则「窗口」菜单中英混排）
        { role: 'minimize', label: s.minimize },
        { role: 'zoom', label: s.zoom },
        { type: 'separator' },
        { role: 'front', label: s.front },
      ],
    },
    {
      label: s.help,
      role: 'help',
      submenu: [
        { label: s.knowBase, click: act('know-base') },
        { label: s.shortcuts, click: act('shortcuts') },
        { type: 'separator' },
        { label: s.license, click: act('license') },
      ],
    },
  ]
}

/** 应用菜单（仅 macOS；其余平台由调用方保持 null）。
 *  品牌名用常量而非 app.getName()：dev 下后者是 package.json name（kart），
 *  打包后才是 productName（KART），菜单文案须两处一致。 */
const APP_BRAND = 'KART'

function applyMenuState(state: MenuState): void {
  menuState = state
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacMenuTemplate(state, APP_BRAND)))
}

/** 从主进程持久化镜像读初始语言（避免启动时菜单语言闪烁：渲染端挂载后才推送真实值） */
function initialMenuState(jsonStore?: JsonStore): MenuState {
  const stored = jsonStore?.get('settings') as { locale?: string } | undefined
  return {
    locale: typeof stored?.locale === 'string' ? stored.locale : 'zh-CN',
    autoSave: true,
    quickRailVisible: true,
    recording: 'idle',
    recordingSupported: true,
  }
}

/** 注册菜单 IPC 并构建初始菜单。渲染端 MenuBar 挂载后推送真实状态。 */
export function registerMenuIpc(jsonStore?: JsonStore): void {
  applyMenuState(initialMenuState(jsonStore))
  ipcMain.on('menu:update-state', (_e, partial: Partial<MenuState>) => {
    if (!partial || typeof partial !== 'object') return
    // 渲染端是可信来源（自家 preload），直接合并；类型由渲染端保证
    applyMenuState({ ...menuState, ...partial })
  })
  if (process.platform === 'darwin') {
    mainLogger.info('menu', `macOS 应用菜单已构建（${APP_BRAND}，locale=${menuState.locale}）`)
  }
}
