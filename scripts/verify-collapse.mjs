/**
 * 连接参数栏收起交互回归（收起=整行消失，入口上移会话 tab）：
 * 连接 mock → 展开态栏高 → 点 ⌃ 收起 → 断言 .bar 消失/tab 按钮出现 →
 * 点 tab ⌄ 展开（栏恢复）→ 再收起 → 点 tab 电源钮断开（状态点变灰）。
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

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

async function main() {
  const stopServer = await ensureDevServer()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const barBox = () => page.evaluate(() => {
    const bar = document.querySelector('.session-pane .bar')
    return bar ? bar.getBoundingClientRect().height : 0
  })

  try {
    await page.goto(`${BASE}/?mock`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.session-pane', { timeout: 10000 })
    await sleep(400)
    const sel = page.locator('.mock-label + .n-select .n-base-selection')
    await sel.click()
    const opt = page.locator('.n-base-select-option', { hasText: '混合 ASCII' }).first()
    await opt.waitFor({ state: 'visible', timeout: 3000 })
    await opt.click()
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 })
    await sleep(1200)

    const expandedH = await barBox()
    await page.screenshot({ path: `${SHOT_DIR}/connbar2-expanded.png`, clip: { x: 0, y: 0, width: 1280, height: 150 } })
    check('展开态参数栏渲染', expandedH > 30, `${expandedH}px`)

    // 收起：⌃ → .bar display:none（高度 0），tab 上出现电源/展开按钮
    await page.locator('.collapse-btn').first().click()
    await sleep(400)
    const collapsedH = await barBox()
    const tab = await page.evaluate(() => ({
      barVisible: (document.querySelector('.session-pane .bar')?.getBoundingClientRect().height ?? 0) > 0,
      connBtn: !!document.querySelector('.session-tab-conn'),
      expandBtn: !!document.querySelector('.session-tab-expand'),
      connOn: document.querySelector('.session-tab-conn')?.classList.contains('on'),
    }))
    check('收起后参数栏高度归零', collapsedH === 0, `${collapsedH}px`)
    check('tab 上出现电源/展开按钮', tab.connBtn && tab.expandBtn, JSON.stringify(tab))
    check('电源钮为已连接态（绿）', tab.connOn === true)
    await page.screenshot({ path: `${SHOT_DIR}/connbar2-collapsed.png`, clip: { x: 0, y: 0, width: 1280, height: 150 } })

    // tab ⌄ 展开：参数栏恢复
    await page.locator('.session-tab-expand').click()
    await sleep(400)
    check('tab ⌄ 展开恢复参数栏', (await barBox()) > 30)

    // 再收起，tab 电源钮断开：状态点变灰
    await page.locator('.collapse-btn').first().click()
    await sleep(400)
    await page.locator('.session-tab-conn').click()
    await sleep(800)
    const afterDisc = await page.evaluate(() => ({
      connOn: document.querySelector('.session-tab-conn')?.classList.contains('on'),
      dotOn: document.querySelector('.session-tab-dot')?.classList.contains('on'),
    }))
    check('tab 电源钮断开（绿→灰）', afterDisc.connOn === false && afterDisc.dotOn === false, JSON.stringify(afterDisc))
    await page.screenshot({ path: `${SHOT_DIR}/connbar2-collapsed-disconnected.png`, clip: { x: 0, y: 0, width: 1280, height: 150 } })

    // retro 主题观感
    await page.evaluate(() => window.__theme.setTheme('retro-console'))
    await sleep(700)
    await page.screenshot({ path: `${SHOT_DIR}/connbar2-collapsed-retro.png`, clip: { x: 0, y: 0, width: 1280, height: 150 } })
  } catch (e) {
    check('脚本异常', false, e.message)
  } finally {
    await browser.close()
    stopServer()
  }
  console.log(`====  ${pass} passed, ${fail} failed  ====`)
  if (fail > 0) process.exitCode = 1
}

main()
