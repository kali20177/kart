/**
 * retro-console 像素主题视觉审核脚本（playwright-core + 系统 Chrome）。
 * 用法：`node scripts/verify-theme-pixel.mjs`。若 5273 端口无 dev 服务器则自动拉起。
 *
 * 目的：给主模型（无视觉）喂截图，用 vision 子代理判断像素风是否「一眼可辨」。
 *   1. mock「混合 ASCII」连接 → 默认主题对照图
 *   2. 切 retro-console → 主界面 / ASCII 表 / 设置弹窗 三张
 * 脚本本身只做确定性断言（无 console 错误），风格是否达标交由 vision 审核。
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = 5273
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = '/tmp/theme-pixel'
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

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

async function main() {
  const stopServer = await ensureDevServer()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  const pageErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/Failed to load resource/.test(t) && /404/.test(t)) return // favicon.ico
    errors.push('console: ' + t)
  })
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message))

  const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` })

  try {
    await page.goto(`${BASE}/?mock`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.session-pane', { timeout: 10000 })
    await page.waitForFunction(() => window.__theme, null, { timeout: 8000 })
    await sleep(300)

    // 连接 mock 产生 RX 数据
    await setScenario(page, '混合 ASCII')
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 })
    await sleep(1500) // 等数据流入 + 气泡渲染
    await shot('main-default') // 默认 glass-industrial-dark 对照

    // 切 retro-console
    await page.evaluate(() => window.__theme.setTheme('retro-console'))
    await sleep(600)
    await shot('main-retro')

    // ASCII 对照表（右侧抽屉）
    await page.locator('button.ascii-btn').first().click()
    await sleep(500)
    await shot('ascii-retro')
    await page.keyboard.press('Escape')
    await sleep(300)

    // 设置弹窗（Naive 组件像素化程度 + 「显示」页的主题自定义覆盖区块）
    await page.locator('button.icon-btn').first().click()
    await sleep(700)
    await page.locator('.settings-nav .nav-item', { hasText: '显示' }).click()
    await sleep(500)
    // 覆盖 UI 是否完整渲染在 DOM（3 个字体框 + 聊天空背景色块 + 清空覆盖按钮）。
    // 它们可能因设置弹窗 430px 视口需滚动才能看见，但不该缺席 DOM。
    const ui = await page.evaluate(() => ({
      fontInputs: document.querySelectorAll('.overrides-block .n-input').length,
      colorPicker: !!document.querySelector('.overrides-block .n-color-picker'),
      clearBtn: [...document.querySelectorAll('.overrides-block button')].some((b) =>
        /清空|Clear/.test(b.textContent ?? '')
      ),
    }))
    check('覆盖 UI 控件齐全（3 字体框+色块+清空）', ui.fontInputs === 3 && ui.colorPicker && ui.clearBtn,
      JSON.stringify(ui))
    await shot('settings-retro')
    await page.keyboard.press('Escape')
    await sleep(300)

    check('无 console/pageerror', errors.length === 0 && pageErrors.length === 0,
      [...errors, ...pageErrors].slice(0, 3).join(' | '))
  } catch (e) {
    check('脚本异常', false, e.message)
    try { await shot('error') } catch { /* ignore */ }
  } finally {
    await browser.close()
    stopServer()
  }

  console.log(`\n截图输出: ${SHOT_DIR}/*.png`)
  console.log(`====  ${pass} passed, ${fail} failed  ====`)
  if (fail > 0) process.exit(1)
}

main()
