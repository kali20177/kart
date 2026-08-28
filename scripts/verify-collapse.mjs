/**
 * 连接栏收起态高度验证（一次性脚本）：连接 mock → 量展开态栏高 → 点收起 →
 * 量收起态栏高 + 截图。断言收起态 ≤ 展开态 - 15px 且 ≤ 28px。
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = 5273
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = '/tmp/theme-review'
mkdirSync(SHOT_DIR, { recursive: true })
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function ensureDevServer() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) return () => {}
  } catch { /* 拉起 */ }
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(800) })
      if (res.ok) break
    } catch { /* 等 */ }
  }
  return () => { child.kill('SIGTERM') }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const stopServer = await ensureDevServer()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const height = () => page.evaluate(() => {
    const bar = document.querySelector('.session-pane .bar')
    return bar ? bar.getBoundingClientRect().height : -1
  })

  try {
    await page.goto(`${BASE}/?mock`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.session-pane', { timeout: 10000 })
    await sleep(400)
    // 连接 mock 产生数据
    const sel = page.locator('.mock-label + .n-select .n-base-selection')
    await sel.click()
    const opt = page.locator('.n-base-select-option', { hasText: '混合 ASCII' }).first()
    await opt.waitFor({ state: 'visible', timeout: 3000 })
    await opt.click()
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 })
    await sleep(1200)

    const expandedH = await height()
    await page.screenshot({ path: `${SHOT_DIR}/connbar-expanded.png`, clip: { x: 0, y: 0, width: 1280, height: 140 } })
    await page.locator('.collapse-btn').first().click()
    await sleep(500)
    const collapsedH = await height()
    await page.screenshot({ path: `${SHOT_DIR}/connbar-collapsed.png`, clip: { x: 0, y: 0, width: 1280, height: 140 } })
    // retro-console 主题下的收起态观感
    await page.evaluate(() => window.__theme.setTheme('retro-console'))
    await sleep(700)
    await page.screenshot({ path: `${SHOT_DIR}/connbar-collapsed-retro.png`, clip: { x: 0, y: 0, width: 1280, height: 140 } })

    // 收起态结构断言：pill 存在、帧解码/校验和按钮不渲染
    const ui = await page.evaluate(() => ({
      pill: !!document.querySelector('.conn-pill'),
      miniRec: !!document.querySelector('.mini-rec'),
      decoderBtns: document.querySelectorAll('.decoder-btn').length,
      nbtnInBar: document.querySelectorAll('.session-pane .bar .n-button').length,
    }))
    console.log(`展开态栏高: ${expandedH}px  收起态栏高: ${collapsedH}px  收益: ${expandedH - collapsedH}px`)
    console.log('收起态 UI:', JSON.stringify(ui))
    const pass = collapsedH <= expandedH - 15 && collapsedH <= 28 && ui.pill && ui.decoderBtns === 0
    console.log(pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } catch (e) {
    console.error('脚本异常:', e.message)
    process.exitCode = 1
  } finally {
    await browser.close()
    stopServer()
  }
}

main()
