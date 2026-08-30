/**
 * dockview 可停靠布局端到端验证：prod 构建 + Electron CDP，
 * 验证三个面板（消息/波形/终端）渲染、切换、关闭、恢复、布局按端口持久化。
 *
 * 用法：`node scripts/verify-dockview.mjs`（需先 `ELECTRON=true vite build`）。
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const SHOT_DIR = '/tmp/dockview-verify'
mkdirSync(SHOT_DIR, { recursive: true })

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
const PORT = await getFreePort()
const CDP = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

// 内层 dockview（会话内三面板）的 tab：嵌套 dockview 经 Teleport 挂在 SessionPane 子树，
// 且 dockview 的 tab 栏与网格是兄弟层级（.dv-tab 不在 .dv-dockview 内），用 .session-pane 定位内层
const tabNames = async (page) =>
  page.$$eval('.session-pane .dv-tab', (tabs) => tabs.map((t) => (t.textContent ?? '').trim().replace(/\s+/g, ' ')))

delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
})
let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += d })

let browser = null
try {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(800) })
      if (res.ok) { browser = await chromium.connectOverCDP(CDP); break }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!browser) {
    throw new Error(`Electron CDP 未就绪\n--- electron stderr ---\n${stderrBuf.slice(-1500)}`)
  }

  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('无窗口页面')
  // 清理上次运行残留的布局存储，保证初始为默认 3 面板（Electron userData 跨运行持久化）。
  // sessionStorage 标记只对首次导航生效，后续 reload 不重复清除（否则会破坏持久化恢复断言）
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__layoutCleared')) return
    sessionStorage.setItem('__layoutCleared', '1')
    const del = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.includes('view-layout:') || k.includes('connbar:collapsed:'))) del.push(k)
    }
    del.forEach((k) => localStorage.removeItem(k))
  })
  let roLoopCount = 0
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (m.text().includes('ResizeObserver loop')) roLoopCount++
    else errors.push(`console.error: ${m.text()}`)
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 })

  // 1. dockview 容器渲染，三个面板 tab 齐全
  await page.locator('.dv-dockview').first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(800)
  let names = await tabNames(page)
  check('初始 3 个面板 tab（消息/波形/终端）', names.length === 3 && names.every((n) => /消息|波形|终端/.test(n)), `tabs=${JSON.stringify(names)}`)
  // 1b. 布局紧凑性：全局按钮（ASCII/设置）并入菜单栏行，dock 区域紧贴菜单栏（无独立工具栏行）
  // 注意：不能按 .toolbar 类名判定——MessageList 内部工具条本就叫 .toolbar，只看几何
  const compact = await page.evaluate(() => {
    const mb = document.querySelector('.menubar')
    const dw = document.querySelector('.dock-wrap')
    if (!mb || !dw) return false
    const mr = mb.getBoundingClientRect()
    const dr = dw.getBoundingClientRect()
    return Math.abs(dr.top - mr.bottom) <= 2
  })
  check('dock 区域紧贴菜单栏（无独立工具栏行）', compact, `menubar.bottom vs dock.top=${await page.evaluate(() => { const m = document.querySelector('.menubar')?.getBoundingClientRect(); const d = document.querySelector('.dock-wrap')?.getBoundingClientRect(); return `${m?.bottom} vs ${d?.top}` })}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '1-initial.png') })

  // 2. 切换 tab：点「终端」→ 激活
  await page.locator('.dv-tab', { hasText: '终端' }).click()
  await page.waitForTimeout(400)
  const activeText = await page.$eval('.session-pane .dv-tab.dv-active-tab', (el) => el.textContent ?? '')
  check('切换激活「终端」tab', activeText.includes('终端'), `active=${JSON.stringify(activeText)}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '2-terminal-active.png') })

  // 2b. 发送框属于消息面板：随消息面板显隐（波形/终端激活时不可见），且位于消息面板内
  await page.locator('.dv-tab', { hasText: '波形' }).click()
  await page.waitForTimeout(400)
  check('波形激活时发送框隐藏（随消息面板）', (await page.locator('.composer:visible').count()) === 0)
  // 2b2. 波形面板挂载时处于隐藏（消息激活），激活后 uPlot 须对到容器尺寸——
  // 回归项：隐藏态按旧尺寸建图 + visibility 守卫跳过 RO 导致 canvas 比容器高几十 px
  const waveSize = await page.evaluate(() => {
    const canvas = document.querySelector('.uplot canvas')
    const area = document.querySelector('.chart-area')
    if (!canvas || !area) return null
    return { cw: canvas.clientWidth, ch: canvas.clientHeight, aw: area.clientWidth, ah: area.clientHeight }
  })
  check(
    '波形激活后 uPlot canvas 尺寸与面板容器一致',
    waveSize !== null && waveSize.cw > 100 && waveSize.ch > 100 &&
      Math.abs(waveSize.cw - waveSize.aw) <= 4 && Math.abs(waveSize.ch - waveSize.ah) <= 4,
    waveSize ? `canvas=${waveSize.cw}x${waveSize.ch} area=${waveSize.aw}x${waveSize.ah}` : '无 canvas'
  )
  await page.locator('.dv-tab', { hasText: '终端' }).click()
  await page.waitForTimeout(400)
  check('终端激活时发送框隐藏（随消息面板）', (await page.locator('.composer:visible').count()) === 0)
  await page.locator('.dv-tab', { hasText: '消息' }).click()
  await page.waitForTimeout(400)
  check('消息激活时发送框可见', (await page.locator('.composer:visible').count()) > 0)
  const inPanel = await page.evaluate(() => {
    const c = document.querySelector('.composer')
    return !!c && c.parentElement?.classList.contains('message-panel')
  })
  check('发送框位于消息面板内', inPanel)

  // 3. 关闭「波形」面板：hover tab 显示关闭按钮再点
  // 视图 tab 为自定义组件（ViewTab），关闭按钮类名 .view-tab-close（非 dockview 默认 tab 的 .dv-default-tab-action）
  const waveTab = page.locator('.dv-tab', { hasText: '波形' })
  await waveTab.hover()
  await waveTab.locator('.view-tab-close').click()
  await page.waitForTimeout(1600) // 等防抖（400ms）持久化落盘
  names = await tabNames(page)
  check('关闭「波形」后剩 2 个 tab', names.length === 2 && !names.some((n) => n.includes('波形')), `tabs=${JSON.stringify(names)}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '3-wave-closed.png') })

  // 4. 布局已按端口写入 localStorage（Electron 下枚举到真实端口，key 带端口名）
  const saved = await page.evaluate(() => {
    const vals = Object.keys(localStorage)
      .filter((k) => k.includes('view-layout:'))
      .map((k) => localStorage.getItem(k) ?? '')
    return vals.join('')
  })
  check('布局持久化到 localStorage（不含已关闭的波形）', saved.length > 0 && !saved.includes('waveform'), `len=${saved.length} hasWaveform=${saved.includes('waveform')}`)

  // 5. reload 后布局保持（波形仍关闭）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.dv-dockview').first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(800)
  names = await tabNames(page)
  check('reload 后持久化布局恢复（波形仍关闭）', names.length === 2 && !names.some((n) => n.includes('波形')), `tabs=${JSON.stringify(names)}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '4-after-reload.png') })

  // 6. 通过「＋」菜单恢复「波形」面板
  await page.locator('.view-add').click()
  await page.locator('.n-dropdown-option', { hasText: '波形' }).first().click()
  await page.waitForTimeout(1600)
  names = await tabNames(page)
  check('「＋」菜单恢复「波形」→ 回到 3 个 tab', names.length === 3, `tabs=${JSON.stringify(names)}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '5-wave-restored.png') })
  // 恢复后布局已重新持久化（含 waveform）
  const afterRestore = await page.evaluate(() => {
    const vals = Object.keys(localStorage)
      .filter((k) => k.includes('view-layout:'))
      .map((k) => localStorage.getItem(k) ?? '')
    return vals.join('')
  })
  check('恢复后面板已重新持久化（布局含 waveform）', afterRestore.includes('waveform'), `len=${afterRestore.length}`)

  // —— 会话级 dockview：新建 / 并排停靠 / 关闭 ——
  // 根级会话 tab 是自定义 tab（SessionTab，根元素带 .session-tab 类），
  // 标题可能是端口名或「会话 N」；内层面板 tab 无此类，天然区分
  const sessionTabs = () => page.locator('.session-tab')
  const closeBtns = () => page.locator('.session-tab-close')

  // 7. 初始 1 个会话 tab，末会话无关闭按钮（替代旧 tab 条 disabled × 的末会话保护）
  check('初始 1 个会话 tab（会话 1）', (await sessionTabs().count()) === 1, `tabs=${JSON.stringify(await tabNames(page))}`)
  check('末会话无关闭按钮', (await closeBtns().count()) === 0)

  // 8. 新建会话：tab 条末尾的 ＋（最后一个 tab 右侧）→ 2 个会话 tab，均可关闭
  await page.locator('.session-add').click()
  await page.waitForTimeout(600)
  check('新建会话后 2 个会话 tab', (await sessionTabs().count()) === 2, `sessionTabs=${await sessionTabs().count()}`)
  check('2 个会话均可关闭', (await closeBtns().count()) === 2)
  await page.screenshot({ path: path.join(SHOT_DIR, '6-two-sessions.png') })

  // 9. 并排停靠：把「会话 2」拖到 dock 区域右缘 → 根级分成两栏（两个串口数据流同屏）
  // dockview 跨 dockview 拖拽不显示对方下拉区（viewId 不匹配），内层 dockview 不会误接收会话面板。
  // 新会话继承上次使用的端口，tab 标题可能同名（本机都显示 /dev/cu.usbserial-*），按插入序取最后 tab。
  // 根级组数 = 含 .session-tab（自定义会话 tab）的 tab 栏数量；内层 tab 栏不含此类
  const rootGroupCount = async () =>
    page.locator('.dv-tabs-and-actions-container').filter({ has: page.locator('.session-tab') }).count()
  check('并排前根级单组', (await rootGroupCount()) === 1)
  const tab2 = page.locator('.session-tab').last()
  const tb = await tab2.boundingBox()
  const dockBox = await page.locator('.dock-wrap').first().boundingBox()
  if (!tb || !dockBox) throw new Error('会话 tab / dock 区域不可测（boundingBox 为空）')
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2)
  await page.mouse.down()
  // 目标：右缘内侧 6px（激活区 10px 内，避开右侧栏 grip 的 3px 悬挑）
  await page.mouse.move(dockBox.x + dockBox.width - 6, tb.y + tb.height / 2, { steps: 15 })
  await page.mouse.up()
  await page.waitForTimeout(900)
  check('拖「会话 2」到右缘 → 根级并排两组', (await rootGroupCount()) === 2, `rootGroups=${await rootGroupCount()}`)
  check('并排后 2 个会话 tab 分属两组（均可见）', (await sessionTabs().count()) === 2)
  await page.screenshot({ path: path.join(SHOT_DIR, '7-sessions-split.png') })

  // 10. 关闭会话 2（hover tab 显示 × 再点）→ 回到 1 个会话，末会话无关闭按钮
  const tab2b = page.locator('.session-tab').last()
  await tab2b.hover()
  await page.waitForTimeout(200)
  await tab2b.locator('.session-tab-close').click()
  await page.waitForTimeout(600)
  check('关闭会话 2 → 回到 1 个会话 tab', (await sessionTabs().count()) === 1, `sessionTabs=${await sessionTabs().count()}`)
  check('末会话恢复无关闭按钮', (await closeBtns().count()) === 0)
  check('并排组随关闭收敛为单组', (await rootGroupCount()) === 1, `rootGroups=${await rootGroupCount()}`)

  // —— 参数栏收起：栏高收缩，数据显示区变高（默认展开）——
  // 数据显示区 = SessionPane 内的 .dock-wrap（App 外层 .dock-wrap 是固定高度容器）
  const barH = async () => (await page.locator('.bar').boundingBox())?.height ?? 0
  const dockH = async () => (await page.locator('.session-pane .dock-wrap').boundingBox())?.height ?? 0
  const barH0 = await barH()
  const dockH0 = await dockH()
  check('参数栏默认展开（高度正常）', barH0 > 30, `h=${barH0}`)
  await page.locator('.collapse-btn').click()
  await page.waitForTimeout(400) // 等 padding 过渡（0.18s）
  const barH1 = await barH()
  const dockH1 = await dockH()
  check('收起后参数栏高度收缩（≥8px）', barH0 - barH1 >= 8, `h ${barH0} → ${barH1}`)
  check('收起后数据显示区变高', dockH1 > dockH0, `dock ${dockH0} → ${dockH1}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '8-connbar-collapsed.png') })
  // 恢复展开（避免残留影响后续流程）。e3f7306 起收起态整行消失、展开入口上移会话 tab
  await page.locator('.session-tab-expand').click()
  await page.waitForTimeout(400)
  check('再点展开恢复原高度', (await barH()) === barH0, `h=${await barH()}`)

  check('无 console/pageerror', errors.length === 0, errors.join('; '))
  // 流程中的面板 attach/detach 会有瞬时 RO loop；断言结束后 idle 2s 无新增（无持续反馈环）
  const idleStart = roLoopCount
  await page.waitForTimeout(2000)
  check('流程后 idle 2s 无新增 RO loop（无持续反馈环）', roLoopCount - idleStart < 5, `新增=${roLoopCount - idleStart} 累计=${roLoopCount}`)
} catch (e) {
  console.log('FAIL  脚本异常:', e.message)
  fail++
} finally {
  await browser?.close().catch(() => {})
  child.kill('SIGTERM')
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL（截图在 ${SHOT_DIR}/）`)
process.exit(fail > 0 ? 1 : 0)
