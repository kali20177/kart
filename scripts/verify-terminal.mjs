/**
 * 终端模式 xterm.js 迁移的浏览器端验证脚本（playwright-core + 系统 Chrome）。
 * 用法：`npm run verify:terminal`。若 5273 端口无 dev 服务器则自动拉起，验证后关闭。
 *
 * 验证点：
 *  - 默认「消息」视图不挂 xterm；切「终端」tab 后 xterm 挂载
 *  - mock shell 场景：连接 → banner 渲染
 *  - char 直通：键入 ls 回车 → 设备回显 + 命令输出渲染
 *  - line 模式：输入 help 回车 → 发送 + 输出渲染
 *  - RX 原始字节视图有数据；无 console/pageerror
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = 5273
const BASE = `http://localhost:${PORT}`
const SHOT_DIR = '/tmp/term-verify'
mkdirSync(SHOT_DIR, { recursive: true })

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 拉起 dev 服务器并等它就绪；返回清理函数（服务器已存在则清理为空操作） */
async function ensureDevServer() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) return () => {}
  } catch { /* 端口未起，需要拉起 */ }
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(800) })
      if (res.ok) break
    } catch { /* 未就绪，继续等 */ }
  }
  return () => { child.kill('SIGTERM') }
}

let pass = 0
let fail = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读取 xterm 缓冲文本（DOM 渲染器时 .xterm-rows 含文本；canvas 渲染器返回 null） */
async function termText(page) {
  const rows = page.locator('.xterm-rows')
  if ((await rows.count()) > 0) {
    const t = await rows.first().textContent()
    return t ?? ''
  }
  return null
}

async function setScenario(page, label) {
  // 场景 NSelect 是「模拟场景」标签的直接后继 .n-select
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
  const pageErrors = []
  // favicon 缺失会触发一条既有的 /favicon.ico 404 console 报错（与终端无关），单独过滤
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/Failed to load resource/.test(t) && /404/.test(t)) return // favicon.ico
    errors.push('console: ' + t)
  })
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message))

  try {
    await page.goto(`${BASE}/?mock`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.session-pane', { timeout: 10000 })
    await sleep(300)

    // 1. 默认消息视图：xterm 已挂载（dockview renderer:'always' 保活）但不可见
    check('默认视图 xterm 不可见', (await page.locator('.xterm:visible').count()) === 0)

    // 2. 切 Shell 场景并连接
    await setScenario(page, 'Shell 交互终端')
    await page.locator('button', { hasText: '连接' }).first().click()
    await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 5000 })
    check('mock 连接成功（按钮变「断开」）', true)

    // 3. 切「终端」tab，xterm 可见
    await page.locator('.dv-tab', { hasText: '终端' }).click()
    await page.locator('.xterm').waitFor({ state: 'visible', timeout: 5000 })
    const canvas = await page.locator('.xterm canvas').count()
    const rowsCount = await page.locator('.xterm-rows').count()
    check('xterm 挂载', true, `canvas=${canvas} domRows=${rowsCount}`)

    // banner 渲染（连接后 150ms 打印）
    await sleep(600)
    const bannerTxt = await termText(page)
    check('banner 渲染', bannerTxt !== null ? bannerTxt.includes('KART 模拟串口终端') : false,
      bannerTxt === null ? '(canvas 渲染器，文本不在 DOM)' : `buffer 含 banner`)

    // banner 对齐：裸 LF 会让 xterm 只换行不回列，下一行出现前导空格（回归项）
    check('banner 对齐（无前导空格）', bannerTxt !== null ? !/\S\s+嵌入式/.test(bannerTxt) : false,
      bannerTxt === null ? '(canvas 渲染器)' : '每行从列 0 开始')

    // 4. char 直通：点击终端聚焦，键入 ls 回车
    await page.locator('.xterm').click()
    await page.keyboard.type('ls\r')
    await sleep(600)

    const lsTxt = await termText(page)
    check('char 模式 ls 输出渲染', lsTxt !== null ? lsTxt.includes('app') : false,
      lsTxt === null ? '(canvas 渲染器，文本不在 DOM)' : '设备回显 + ls 输出')

    await page.screenshot({ path: `${SHOT_DIR}/char-ls.png`, fullPage: false })

    // 4b. 回归：tab 无补全不回显 + Backspace 能擦除文本末尾（不再残留）
    await page.locator('.xterm').click()
    await page.keyboard.type('cd lo')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Backspace')
    await sleep(400)
    const tabTxt = await termText(page)
    check('tab+Backspace 擦除干净', tabTxt !== null ? !tabTxt.includes('cd lo') : false,
      tabTxt === null ? '(canvas 渲染器)' : 'o 已被擦除')

    // 4c. 回归：CJK 宽字符 Backspace 整格擦除（不再残留半字）
    await page.keyboard.insertText('缓')
    await sleep(300)
    await page.keyboard.press('Backspace')
    await sleep(300)
    const cjkTxt = await termText(page)
    check('CJK 宽字符 Backspace 擦除干净', cjkTxt !== null ? !cjkTxt.includes('缓') : false,
      cjkTxt === null ? '(canvas 渲染器)' : '宽字符已整格擦除')

    // 执行挂起的 "cd l"（mock 行缓冲跨模式保留），清空后再进 line 模式
    await page.keyboard.press('Enter')
    await sleep(400)

    // 5. line 模式：切「行发送」，输入 help 回车
    await page.locator('button', { hasText: '行发送' }).click()
    const input = page.locator('.term-input input')
    await input.waitFor({ state: 'visible', timeout: 3000 })
    await input.click()
    await input.fill('help')
    await input.press('Enter')
    await sleep(600)

    const helpTxt = await termText(page)
    check('line 模式 help 输出渲染', helpTxt !== null ? helpTxt.includes('可用命令') : false,
      helpTxt === null ? '(canvas 渲染器，文本不在 DOM)' : 'help 命令输出')

    await page.screenshot({ path: `${SHOT_DIR}/line-help.png`, fullPage: false })

    // 6. 工具栏 RX 视图（rawDump 为 DOM 文本，可独立于渲染器断言数据链路）
    await page.locator('.term-pane .toolbar button', { hasText: 'RX' }).click()
    await sleep(200)
    const raw = await page.locator('.raw-dump').textContent()
    check('RX 原始字节视图有数据', raw !== null && raw.trim().length > 0, (raw ?? '').slice(0, 40))
    await page.screenshot({ path: `${SHOT_DIR}/rx-dump.png`, fullPage: false })

    // 7. console 错误
    await sleep(300)
    check('无 console/pageerror', errors.length === 0 && pageErrors.length === 0,
      [...errors, ...pageErrors].slice(0, 3).join(' | '))

    await page.screenshot({ path: `${SHOT_DIR}/final.png`, fullPage: true })
  } catch (e) {
    check('脚本异常', false, e.message)
    try { await page.screenshot({ path: `${SHOT_DIR}/error.png` }) } catch { /* ignore */ }
  } finally {
    await browser.close()
    stopServer()
  }

  console.log(`\n====  ${pass} passed, ${fail} failed  ====`)
  if (fail > 0) process.exit(1)
}

main()
