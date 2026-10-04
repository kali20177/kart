import { describe, it, expect, vi } from 'vitest'

// ── electron mock：menu.ts 顶层只用到 app/BrowserWindow/Menu/ipcMain 的壳 ──
vi.mock('electron', () => ({
  app: { getName: () => 'KART' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((t: unknown) => t) },
  ipcMain: { on: vi.fn() },
}))
vi.mock('@/main/logger', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// 延迟 import：vi.mock 已注册，menu.ts 内 import 命中 mock
import { buildMacMenuTemplate } from '@/main/menu'
import type { MenuState } from '@/types'
import type { MenuItemConstructorOptions } from 'electron'

const BASE: MenuState = {
  locale: 'zh-CN',
  autoSave: true,
  quickRailVisible: true,
  sessionCount: 2,
  recording: 'idle',
  recordingSupported: true,
}

/** 按顶层菜单 label 找子菜单（Electron 类型上 submenu 可为 Menu，构建模板时恒为数组，断言收窄） */
function submenuOf(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const menu = template.find((m) => m.label === label)
  expect(menu, `顶层菜单「${label}」应存在`).toBeTruthy()
  return (menu!.submenu ?? []) as MenuItemConstructorOptions[]
}

function itemOf(submenu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const item = submenu.find((m) => m.label === label)
  expect(item, `菜单项「${label}」应存在`).toBeTruthy()
  return item!
}

describe('buildMacMenuTemplate（macOS 原生菜单模板）', () => {
  it('七个顶层菜单：应用名/文件/编辑/查看/工具/窗口/帮助（zh-CN）', () => {
    const tpl = buildMacMenuTemplate(BASE, 'KART')
    expect(tpl.map((m) => m.label)).toEqual(['KART', '文件', '编辑', '查看', '工具', '窗口', '帮助'])
  })

  it('应用菜单：关于/检查更新/设置(⌘,)/隐藏/退出，中文 label 覆盖 role 默认英文', () => {
    const appMenu = submenuOf(buildMacMenuTemplate(BASE, 'KART'), 'KART')
    expect(itemOf(appMenu, '关于 KART').click).toBeTypeOf('function')
    expect(itemOf(appMenu, '检查更新…').click).toBeTypeOf('function')
    const settings = itemOf(appMenu, '设置…')
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
    expect(itemOf(appMenu, '隐藏 KART').role).toBe('hide')
    expect(itemOf(appMenu, '退出 KART').role).toBe('quit')
  })

  it('编辑菜单：剪切/拷贝/粘贴等 role 齐全——⌘C/⌘V 由它派发（null 菜单会让这些快捷键失效）', () => {
    const edit = submenuOf(buildMacMenuTemplate(BASE, 'KART'), '编辑')
    expect(edit.map((m) => m.role)).toEqual([
      'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
    ])
    // 回归护栏：不含 undo/redo——⌘Z 被菜单拦截后 DOM 收不到 keydown，
    // InputComposer 的 HEX 排版撤销栈（自维护）会失效
    expect(edit.map((m) => m.role)).not.toContain('undo')
    expect(edit.map((m) => m.role)).not.toContain('redo')
  })

  it('文件菜单：新建会话 ⌘N + 录制项按状态换标签/禁用 + 自动保存勾选态', () => {
    const tpl = buildMacMenuTemplate({ ...BASE, recording: 'idle' }, 'KART')
    const file = submenuOf(tpl, '文件')
    expect(itemOf(file, '新建会话').accelerator).toBe('CmdOrCtrl+N')
    expect(itemOf(file, '开始录制').enabled).toBe(true)
    expect(itemOf(file, '自动保存配置').checked).toBe(true)

    const fileRec = submenuOf(buildMacMenuTemplate({ ...BASE, recording: 'recording' }, 'KART'), '文件')
    expect(itemOf(fileRec, '停止录制').enabled).toBe(true)

    const fileStop = submenuOf(buildMacMenuTemplate({ ...BASE, recording: 'stopping' }, 'KART'), '文件')
    expect(itemOf(fileStop, '停止录制').enabled).toBe(false)

    const fileNoSup = submenuOf(buildMacMenuTemplate({ ...BASE, recordingSupported: false }, 'KART'), '文件')
    expect(itemOf(fileNoSup, '开始录制').enabled).toBe(false)

    const fileNoSave = submenuOf(buildMacMenuTemplate({ ...BASE, autoSave: false }, 'KART'), '文件')
    expect(itemOf(fileNoSave, '自动保存配置').checked).toBe(false)
  })

  it('查看菜单：快捷命令栏勾选态；不含 reload（页面重载残留串口句柄）', () => {
    const viewOn = submenuOf(buildMacMenuTemplate({ ...BASE, quickRailVisible: true }, 'KART'), '查看')
    expect(itemOf(viewOn, '快捷命令栏').checked).toBe(true)
    const viewOff = submenuOf(buildMacMenuTemplate({ ...BASE, quickRailVisible: false }, 'KART'), '查看')
    expect(itemOf(viewOff, '快捷命令栏').checked).toBe(false)
    const roles = viewOff.map((m) => m.role)
    expect(roles).toContain('toggleDevTools')
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
  })

  it('en 语言：顶层菜单与动作项切英文，未知 locale 回落 en', () => {
    const tpl = buildMacMenuTemplate({ ...BASE, locale: 'en-US' }, 'KART')
    expect(tpl.map((m) => m.label)).toEqual(['KART', 'File', 'Edit', 'View', 'Tools', 'Window', 'Help'])
    expect(itemOf(submenuOf(tpl, 'KART'), 'About KART').click).toBeTypeOf('function')
    // 未知 locale（如意外值）按英文兜底，不崩
    const fallback = buildMacMenuTemplate({ ...BASE, locale: 'xx-YY' }, 'KART')
    expect(fallback.map((m) => m.label)).toContain('File')
  })

  it('窗口菜单 role 项显式中文标签（role 默认 label 是英文，防中英混排泄漏）', () => {
    const win = submenuOf(buildMacMenuTemplate(BASE, 'KART'), '窗口')
    expect(win.map((m) => m.label ?? null)).toEqual(['最小化', '缩放', null, '前置全部窗口'])
    const enWin = submenuOf(buildMacMenuTemplate({ ...BASE, locale: 'en-US' }, 'KART'), 'Window')
    expect(enWin.map((m) => m.label ?? null)).toEqual(['Minimize', 'Zoom', null, 'Bring All to Front'])
  })

  it('单会话时「关闭当前会话」禁用——关闭末会话会销毁重建，静默清掉活连接与历史；多会话可用', () => {
    const single = submenuOf(buildMacMenuTemplate({ ...BASE, sessionCount: 1 }, 'KART'), '文件')
    expect(itemOf(single, '关闭当前会话').enabled).toBe(false)
    const multi = submenuOf(buildMacMenuTemplate({ ...BASE, sessionCount: 2 }, 'KART'), '文件')
    expect(itemOf(multi, '关闭当前会话').enabled).toBe(true)
  })

  it('工具菜单：ASCII 表/文件传输（MenuAction 的 ascii/file-transfer 有原生发出方）', () => {
    const tools = submenuOf(buildMacMenuTemplate(BASE, 'KART'), '工具')
    expect(itemOf(tools, 'ASCII 表').click).toBeTypeOf('function')
    expect(itemOf(tools, '文件传输…').click).toBeTypeOf('function')
  })

  it('帮助菜单：常见问题/快捷键/许可证经 IPC 动作回流渲染层', () => {
    const help = submenuOf(buildMacMenuTemplate(BASE, 'KART'), '帮助')
    expect(itemOf(help, '常见问题').click).toBeTypeOf('function')
    expect(itemOf(help, '快捷键').click).toBeTypeOf('function')
    expect(itemOf(help, '许可证').click).toBeTypeOf('function')
  })
})
