/**
 * 视图 tab 主题回归：亮/暗主题下切换 消息/波形/终端/仪表盘，
 * 断言非激活 view-tab 背景始终透明（不回落 dockview abyss 默认 #10192c），
 * 且 dockview shell 挂的是自有主题类而非 abyss。
 *
 * 背景：dockview 未显式传 theme 时默认 abyss 暗色主题类下渗，亮色主题下
 * 「终端激活（组转为 dv-inactive-group）→ 消息/波形 tab 露 #10192c 暗底」。
 * 用法：`node scripts/verify-view-tab-theme.mjs`
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import net from 'node:net'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const SHOT_DIR = '/tmp/view-tab-theme'
mkdirSync(SHOT_DIR, { recursive: true })

const VITE_PORT = 5273
const VITE = `http://localhost:${VITE_PORT}`

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
const CDP_PORT = await getFreePort()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

const vite = spawn('npm', ['run', 'dev', '--', '--port', String(VITE_PORT), '--strictPort'], { stdio: 'ignore' })
let viteUp = false
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try {
    const res = await fetch(`${VITE}/`, { signal: AbortSignal.timeout(600) })
    if (res.ok) { viteUp = true; break }
  } catch { /* 等待 */ }
}
if (!viteUp) { console.error('vite 未就绪'); vite.kill('SIGTERM'); process.exit(1) }

delete process.env.ELECTRON_RUN_AS_NODE
const electron = spawn(electronPath, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_DEV_SERVER_URL: `${VITE}/?mock` },
})
let stderrBuf = ''
electron.stderr.on('data', (d) => { stderrBuf += d })

let browser = null
try {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(700) })
      if (res.ok) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); break }
    } catch { /* 未就绪 */ }
    await sleep(300)
  }
  if (!browser) throw new Error(`Electron CDP 未就绪\n--- stderr ---\n${stderrBuf.slice(-1200)}`)
  const page = browser.contexts()[0]?.pages()[0]
  await page.waitForSelector('.session-pane', { timeout: 15000 })
  await page.waitForFunction(() => window.__theme, null, { timeout: 8000 })

  for (const themeId of ['glass-industrial-light', 'glass-industrial-dark']) {
    await page.evaluate((tid) => window.__theme.setTheme(tid), themeId)
    await sleep(300)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.session-pane', { timeout: 15000 })
    await sleep(600)

    // 防线 1：abyss 主题类不得出现在 shell 上；自有主题类必须就位
    const abyssCount = await page.locator('[class*="dockview-theme-abyss"]').count()
    const kartCount = await page.locator('[class*="dockview-theme-kart"]').count()
    check(`[${themeId}] shell 无 abyss 主题类`, abyssCount === 0, `abyss×${abyssCount}`)
    check(`[${themeId}] dockview 已挂自有主题类`, kartCount >= 2, `kart×${kartCount}`)

    // 防线 2：逐个激活「已打开」的视图 tab，非激活 tab 背景必须保持透明（曾在此处露 #10192c）
    const tabNames = await page.$$eval('.session-pane .dv-tab .view-tab-name', (els) =>
      els.map((e) => (e.textContent ?? '').trim())
    )
    for (const v of tabNames) {
      await page.locator('.dv-tab', { hasText: v }).click()
      await sleep(350)
      const info = await page.evaluate(() => ({
        activeTab: document.querySelector('.session-pane .dv-tab.dv-active-tab')
          ? (document.querySelector('.session-pane .dv-tab.dv-active-tab').textContent ?? '').trim()
          : '(无)',
        tabs: [...document.querySelectorAll('.session-pane .dv-tab .view-tab')].map((el) => ({
          name: (el.querySelector('.view-tab-name')?.textContent ?? '').trim(),
          active: el.classList.contains('active'),
          bg: getComputedStyle(el).backgroundColor,
        })),
      }))
      check(`[${themeId}] 点击「${v}」后 dockview 激活 tab 正确`, info.activeTab.includes(v), `active=${info.activeTab}`)
      const dark = info.tabs.filter((b) => !b.active && b.bg !== 'rgba(0, 0, 0, 0)')
      check(
        `[${themeId}] 激活「${v}」后非激活 tab 背景透明`,
        dark.length === 0,
        dark.length ? JSON.stringify(dark) : `tabs=${info.tabs.length}`
      )
      const activeBg = info.tabs.find((b) => b.active)?.bg ?? ''
      check(
        `[${themeId}] 「${v}」激活 tab 有主题底色`,
        activeBg !== '' && activeBg !== 'rgba(0, 0, 0, 0)',
        activeBg
      )
    }
    await page.screenshot({ path: `${SHOT_DIR}/${themeId}.png` })
  }
  console.log(`\n====  ${pass} passed, ${fail} failed  ====`)
  console.log('截图输出:', SHOT_DIR)
  if (fail > 0) process.exitCode = 1
} catch (e) {
  console.error('脚本异常:', e.message)
  try { await (browser?.contexts()[0]?.pages()[0])?.screenshot({ path: `${SHOT_DIR}/error.png` }) } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  electron.kill('SIGTERM')
  vite.kill('SIGTERM')
}
