/**
 * 终端视口 × 全主题视觉审核脚本（playwright-core + 系统 Chrome）。
 * 用法：`node scripts/verify-terminal-themes.mjs`。若 5273 端口无 dev 服务器则自动拉起。
 *
 * 连接「Shell 交互终端」mock（ANSI banner/提示符），切到 终端 tab，
 * 发 color 命令刷出 ANSI 前景色带，再拖拽出一段选区；逐主题截图。
 * 截图交主模型目检：底色/前景/光标/选区/ANSI 16 色是否与主题协调。
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = 5273
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = '/tmp/term-theme-review'
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

    // Shell 交互终端场景：连接即有 ANSI banner + 提示符
    await setScenario(page, 'Shell 交互终端')
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 })
    await sleep(600)

    // 切到终端 tab，确保 char 直通模式，聚焦后发 color 命令刷色带
    await page.locator('.dv-tab', { hasText: '终端' }).click()
    await sleep(400)
    await page.locator('button', { hasText: '直通' }).first().click()
    await sleep(200)
    await page.locator('.xterm-host').click()
    await sleep(200)
    await page.keyboard.type('color')
    await page.keyboard.press('Enter')
    await sleep(500)

    // 拖拽出选区（验证 selectionBackground）
    const box = await (await page.$('.xterm-host')).boundingBox()
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.2, { steps: 8 })
    await page.mouse.up()
    await sleep(300)

    const themes = ['glass-industrial-dark', 'glass-industrial-light', 'oled-hud', 'retro-console']
    for (const id of themes) {
      await page.evaluate((tid) => window.__theme.setTheme(tid), id)
      await sleep(700)
      await page.screenshot({ path: `${SHOT_DIR}/terminal-${id}.png` })
    }

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
