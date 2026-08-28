/**
 * 全部主题视觉审核脚本（playwright-core + 系统 Chrome）。
 * 用法：`node scripts/verify-themes-all.mjs`。若 5273 端口无 dev 服务器则自动拉起。
 *
 * 对 registry 中每套主题：连接「混合 ASCII」mock 产生数据流，
 * 截 主界面 + 设置弹窗（显示 tab）；retro-console 额外截 ASCII 表。
 * 截图交主模型目检，风格/配色/可读性是否达标由视觉审核判断。
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
  } catch { /* 端口未起，需要拉起 */ }
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(800) })
      if (res.ok) break
    } catch { /* 未就绪，继续等 */ }
  }
  return () => { child.kill('SIGTERM') }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function setScenario(page, label) {
  const sel = page.locator('.mock-label + .n-select .n-base-selection')
  await sel.click()
  const opt = page.locator('.n-base-select-option', { hasText: label }).first()
  await opt.waitFor({ state: 'visible', timeout: 3000 })
  await opt.click()
}

async function main() {
  const stopServer = await ensureDevServer()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  try {
    await page.goto(`${BASE}/?mock`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.session-pane', { timeout: 10000 })
    await page.waitForFunction(() => window.__theme, null, { timeout: 8000 })
    await sleep(300)

    // 连接 mock 产生 RX 数据（气泡/统计/波形都有内容）
    await setScenario(page, '混合 ASCII')
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 })
    await sleep(1500)

    const themes = await page.evaluate(() => window.__theme.listThemes
      ? window.__theme.listThemes().map(t => t.id)
      : ['glass-industrial-dark', 'glass-industrial-light', 'oled-hud', 'retro-console'])

    for (const id of themes) {
      await page.evaluate((tid) => window.__theme.setTheme(tid), id)
      await sleep(700)
      await page.screenshot({ path: `${SHOT_DIR}/main-${id}.png` })
      // 设置弹窗 · 显示 tab（Naive 组件 + 主题覆盖区块在每主题下的渲染）
      await page.locator('button.icon-btn').first().click()
      await sleep(700)
      await page.locator('.settings-nav .nav-item', { hasText: '显示' }).click()
      await sleep(500)
      await page.screenshot({ path: `${SHOT_DIR}/settings-${id}.png` })
      // 主题下拉展开态：验证每个选项的配色预览色样（render-label）
      await page.locator('.overrides-block').first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {})
      const themeSelect = page.locator('.n-form-item:has(.n-form-item-label)', { hasText: '主题' }).first()
      await themeSelect.locator('.n-base-selection').click()
      await sleep(500)
      await page.screenshot({ path: `${SHOT_DIR}/theme-dropdown-${id}.png` })
      await page.keyboard.press('Escape')
      await sleep(300)
      await page.keyboard.press('Escape')
      await sleep(300)
    }

    // retro-console 的 ASCII 表抽屉（像素字/硬边框重点检查面）
    await page.evaluate(() => window.__theme.setTheme('retro-console'))
    await sleep(700)
    await page.locator('button.ascii-btn').first().click()
    await sleep(500)
    await page.screenshot({ path: `${SHOT_DIR}/ascii-retro-console.png` })

    if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5))
    else console.log('no page errors')
    console.log(`截图输出: ${SHOT_DIR}/`)
  } catch (e) {
    console.error('脚本异常:', e.message)
    try { await page.screenshot({ path: `${SHOT_DIR}/error.png` }) } catch { /* ignore */ }
    process.exitCode = 1
  } finally {
    await browser.close()
    stopServer()
  }
}

main()
