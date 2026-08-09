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

const tabNames = async (page) =>
  page.$$eval('.dv-tab', (tabs) => tabs.map((t) => (t.textContent ?? '').trim().replace(/\s+/g, ' ')))

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
      if (k && k.includes('view-layout:')) del.push(k)
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
  await page.locator('.dv-dockview').waitFor({ timeout: 10000 })
  await page.waitForTimeout(800)
  let names = await tabNames(page)
  check('初始 3 个面板 tab（消息/波形/终端）', names.length === 3 && names.every((n) => /消息|波形|终端/.test(n)), `tabs=${JSON.stringify(names)}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '1-initial.png') })

  // 2. 切换 tab：点「终端」→ 激活
  await page.locator('.dv-tab', { hasText: '终端' }).click()
  await page.waitForTimeout(400)
  const activeText = await page.$eval('.dv-tab.dv-active-tab', (el) => el.textContent ?? '')
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
  const waveTab = page.locator('.dv-tab', { hasText: '波形' })
  await waveTab.hover()
  await waveTab.locator('.dv-default-tab-action').click()
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
  await page.locator('.dv-dockview').waitFor({ timeout: 10000 })
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
