/**
 * 连接参数栏小下拉菜单可读性回归（默认窗口 1100x760）：
 * 参数栏拥挤时 flex 会把各控件压缩到 min-content，小下拉（传输/数据位/校验/停止位）
 * 若菜单强制与触发器同宽，选中行的对勾留白会把选项文字裁成竖缝。
 * 断言：逐个打开四个下拉，每个选项的 content 无横向裁剪（scrollWidth <= clientWidth），
 * 且 950px 窄窗口下同样成立。
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = 5273
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = '/tmp/connbar-menus-verify'
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

// 参数栏内会变形的小下拉：传输/数据位/校验/停止位（端口/波特率本就 consistent=false）
const CASES = [
  { idx: 0, name: '传输类型' },
  { idx: 3, name: '数据位' },
  { idx: 4, name: '校验' },
  { idx: 5, name: '停止位' }
]

async function verifyViewport(browser, width, height, tag) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.session-pane', { timeout: 10000 })
  await sleep(400)

  for (const c of CASES) {
    await page.locator('.session-pane .bar .n-select').nth(c.idx).locator('.n-base-selection').click()
    await sleep(350)
    const result = await page.evaluate(() => {
      const menus = document.querySelectorAll('.n-base-select-menu')
      const menu = menus[menus.length - 1]
      const mr = menu.getBoundingClientRect()
      const rows = [...menu.querySelectorAll('.n-base-select-option')].map((o) => {
        const content = o.querySelector('.n-base-select-option__content')
        const cr = content.getBoundingClientRect()
        const cs = getComputedStyle(content)
        return {
          text: content.textContent.trim(),
          clipped: content.scrollWidth > content.clientWidth + 1,
          visible: cr.width > 0 && cr.height > 0,
          overflow: cs.overflow
        }
      })
      return { menuW: Math.round(mr.width), rows }
    })
    const bad = result.rows.filter((r) => r.clipped || !r.visible)
    check(
      `[${tag}] ${c.name} 菜单选项无裁剪`,
      bad.length === 0 && result.rows.length > 0,
      `菜单宽 ${result.menuW}px，选项 ${result.rows.length} 个${bad.length ? `，裁剪: ${bad.map((b) => b.text).join('/')}` : ''}`
    )
    await page.screenshot({ path: `${SHOT_DIR}/menu-${tag}-${c.idx}.png`, clip: { x: 0, y: 0, width: Math.min(width, 700), height: 320 } })
    await page.keyboard.press('Escape')
    await sleep(250)
  }
  await page.close()
}

async function main() {
  const stopServer = await ensureDevServer()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  try {
    await verifyViewport(browser, 1100, 760, 'default')
    await verifyViewport(browser, 950, 720, 'narrow')
  } finally {
    await browser.close()
    stopServer()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
