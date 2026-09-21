/**
 * 绘图行标记（标记模式）真机端到端验证：prod 构建 + Electron CDP + RTT over TCP。
 *
 * 验证目标（用户视角的一条完整动线）：
 *  1. 宽松模式下，设备普通文本日志里的裸数字被当成采样值画进波形（对照，证明问题真实存在）；
 *  2. 在「设置 ▸ 波形解析 ▸ 绘图行标记」填 `>` 后，只有标记行成点，日志行被隔离；
 *  3. 标记持久化，重载 + 重连后仍然生效；
 *  4. 多主题截图（交付前目检用）。
 *
 * 前置：
 *  - `ELECTRON=true vite build`（本脚本不自动构建）
 *  - rb-demo 测试分支固件已烧录，OpenOCD RTT TCP 服务在 127.0.0.1:9090
 *    （~/Documents/stm32f103-rb-demo/tools/openocd-rtt.sh 前台运行）
 *
 * 用法：node scripts/verify-waveform-marker.mjs
 * 环境变量：KART_RTT_HOST / KART_RTT_PORT（默认 127.0.0.1:9090）、KART_SHOT_DIR
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const SHOT_DIR = process.env.KART_SHOT_DIR || '/tmp/waveform-marker-verify'
const RTT_HOST = process.env.KART_RTT_HOST || '127.0.0.1'
const RTT_PORT = Number(process.env.KART_RTT_PORT || 9090)
const THEMES = ['glass-industrial-dark', 'glass-industrial-light', 'retro-console', 'oled-hud']
const MARKER = '>'
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
  if (!browser) throw new Error(`Electron CDP 未就绪\n--- electron stderr ---\n${stderrBuf.slice(-1500)}`)

  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('无窗口页面')
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // 设备二进制流进 xterm 终端面板会产生解析报错（与本功能无关，环境噪声）
    if (t.includes('Parsing error') || t.includes('xterm')) return
    errors.push(`console.error: ${t}`)
  })

  // 起始状态：清掉标记（宽松模式），只在首次导航生效（后续 reload 保留设置，用于验证持久化）
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__wmSeeded')) return
    sessionStorage.setItem('__wmSeeded', '1')
    try {
      const raw = localStorage.getItem('kart:settings')
      const s = raw ? JSON.parse(raw) : {}
      s.waveform = { ...(s.waveform ?? {}), parse: {} }
      localStorage.setItem('kart:settings', JSON.stringify(s))
    } catch { /* 忽略：读不到就按默认宽松模式跑 */ }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 })
  await page.locator('.session-pane').first().waitFor({ timeout: 10000 })

  // —— 连接 TCP（RTT 服务）——
  async function connectTcp() {
    // 传输选择器是参数栏里第一个 NSelect；选 TCP 后出现主机/端口两框
    await page.locator('.bar .n-base-selection').first().click()
    await page.locator('.n-base-select-option:visible', { hasText: 'TCP' }).first().click()
    await page.waitForTimeout(300)
    const host = page.locator('.bar input[placeholder="主机 / IP"]').first()
    await host.click()
    await host.fill(RTT_HOST)
    const port = page.locator('.bar .n-input-number input').first()
    await port.click()
    await port.press('Meta+a')
    await port.pressSequentially(String(RTT_PORT))
    await port.press('Enter')
    await page.keyboard.press('Escape') // 收起输入框的浮层（若有）
    for (let i = 0; i < 3; i++) {
      await page.locator('.bar button', { hasText: '连接' }).first().click({ timeout: 5000 })
      const ok = await page.locator('.bar button', { hasText: '断开' }).first()
        .waitFor({ timeout: 6000 }).then(() => true).catch(() => false)
      if (ok) return true
      await page.waitForTimeout(1000)
    }
    return false
  }

  check('TCP 会话已连接 RTT 服务', await connectTcp(), `${RTT_HOST}:${RTT_PORT}`)

  // —— 波形面板激活 ——
  await page.locator('.dv-tab', { hasText: '波形' }).first().click()
  await page.waitForTimeout(600)
  await page.locator('.chart-area').first().waitFor({ timeout: 8000 })

  /** 图例通道名（带 .ch-dot 的按钮即通道按钮，与 暂停/清空/导出 区分） */
  const legend = () =>
    page.$$eval('.wave-wrap .toolbar button', (btns) =>
      btns.filter((b) => b.querySelector('.ch-dot')).map((b) => (b.textContent ?? '').replace(/[\s\u00b7]+/g, ' ').trim())
    )
  /** 扫描多个横向位置收集光标读数（去重）——单点可能恰好落在日志采样上，扫描更稳 */
  async function sweepTooltip(steps = 10) {
    const box = await page.locator('.chart-area').first().boundingBox()
    if (!box) return []
    const seen = new Map()
    for (let k = 1; k <= steps; k++) {
      await page.mouse.move(box.x + (box.width * k) / (steps + 1), box.y + box.height * 0.5)
      await page.waitForTimeout(140)
      const rows = await page.$$eval('.cursor-tooltip .tooltip-ch', (els) =>
        els.map((e) => (e.textContent ?? '').trim())
      )
      for (const r of rows) {
        const m = r.match(/^(.*?):\s*(-?[\d.]+)\s*$/)
        if (m) seen.set(`${m[1].trim()}|${m[2]}`, { label: m[1].trim(), value: Number(m[2]) })
      }
    }
    return [...seen.values()]
  }
  const pointCount = async () => {
    const tag = await page.locator('.wave-wrap .toolbar .n-tag').first().textContent()
    return Number((tag ?? '').replace(/\D/g, '')) || 0
  }
  /** 轮询图例直到满足断言或超时（通道随数据到达逐个出现，单次读取会有时序假象） */
  async function pollLegend(pred, timeoutMs = 15000) {
    const t0 = Date.now()
    let last = []
    while (Date.now() - t0 < timeoutMs) {
      last = await legend()
      if (pred(last)) return last
      await page.waitForTimeout(500)
    }
    return last
  }
  const pollPoints = async (timeoutMs = 15000) => {
    const t0 = Date.now()
    let n = 0
    while (Date.now() - t0 < timeoutMs) {
      n = await pointCount()
      if (n > 0) return n
      await page.waitForTimeout(500)
    }
    return n
  }

  // —— 1. 宽松模式（对照）：日志里的裸数字被当成采样值 ——
  const legendLoose = await pollLegend((lg) => lg.length >= 3)
  const nLoose = await pollPoints()
  check('宽松模式：波形有数据在画', nLoose > 0, `点数=${nLoose}`)
  check(
    '宽松模式（对照）：设备普通日志的数字被当成通道',
    legendLoose.length >= 3,
    `通道=${JSON.stringify(legendLoose)}`
  )
  // 悬停取样有随机性：先扫一轮，没扫到异常采样（日志行采样）再补一轮
  let looseRead = await sweepTooltip()
  if (!looseRead.some((r) => Math.abs(r.value) > 2000)) {
    await page.waitForTimeout(3000)
    looseRead = [...looseRead, ...(await sweepTooltip(16))]
  }
  const huge = looseRead.filter((r) => Math.abs(r.value) > 2000)
  check(
    '宽松模式（对照）：日志原文里的 Pa 读数混进曲线（>2000 的异常采样）',
    huge.length > 0,
    `异常读数=${JSON.stringify(huge)}`
  )
  await page.screenshot({ path: path.join(SHOT_DIR, '1-permissive-polluted.png') })

  // —— 2. 设置里填标记 ——
  await page.locator('button[title="设置"]').first().click()
  await page.waitForTimeout(500)
  await page.locator('.settings-nav button.nav-item', { hasText: '波形解析' }).first().click()
  await page.waitForTimeout(400)
  const prefixInput = page.locator('.n-modal input[placeholder*="留空"]').first()
  await prefixInput.click()
  await prefixInput.fill(MARKER)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOT_DIR, '2-settings-marker-input.png') })
  check('设置界面填入了绘图行标记', (await prefixInput.inputValue()) === MARKER)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // —— 3. 标记模式：清空后只有标记行成点 ——
  await page.locator('.wave-wrap .toolbar button', { hasText: '清空' }).first().click()
  const legendMarked = await pollLegend((lg) => lg.length === 2 && lg.includes('Temp') && lg.includes('Pressure'))
  const nMarked = await pollPoints()
  check('标记模式：波形有数据在画', nMarked > 0, `点数=${nMarked}`)
  check(
    '标记模式：通道恰为 Temp / Pressure（日志数字不再成通道）',
    legendMarked.length === 2 && legendMarked.includes('Temp') && legendMarked.includes('Pressure'),
    `通道=${JSON.stringify(legendMarked)}`
  )
  const markedRead = await sweepTooltip()
  const inRange = markedRead.filter((r) =>
    (r.label === 'Temp' && r.value >= 10 && r.value <= 45) ||
    (r.label === 'Pressure' && r.value >= 900 && r.value <= 1100)
  )
  check('标记模式：读数落在 BMP180 量程内', inRange.length > 0, `读数=${JSON.stringify(markedRead)}`)
  check(
    '标记模式：无日志原文数字混入（无 |值|>2000）',
    markedRead.every((r) => Math.abs(r.value) <= 2000),
    `读数=${JSON.stringify(markedRead)}`
  )
  check('标记模式：无「绘图数据被拒」提示（夹具格式正确）', (await page.locator('.wave-wrap .n-tag', { hasText: '被拒' }).count()) === 0)
  await page.waitForTimeout(12000) // 攒够 12 个 1 Hz 采样，截图里能看到真实曲线形状
  await page.screenshot({ path: path.join(SHOT_DIR, '3-marker-clean.png') })

  // —— 3b. 标记写错 → 被拒提示可见（不静默画错）——
  // 把标记临时改成设备日志的行首（[CLOCK]）：这些行以标记开头、内容不是数值 → 整行作废并上报
  await page.locator('button[title="设置"]').first().click()
  await page.waitForTimeout(400)
  await page.locator('.settings-nav button.nav-item', { hasText: '波形解析' }).first().click()
  await page.waitForTimeout(300)
  await prefixInput.click()
  await prefixInput.fill('[CLOCK]')
  await page.keyboard.press('Escape')
  const badge = page.locator('.wave-wrap .n-tag', { hasText: '被拒' })
  let badgeOk = false
  for (let i = 0; i < 20; i++) {
    if (await badge.count()) { badgeOk = true; break }
    await page.waitForTimeout(500)
  }
  await badge.first().hover().catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(SHOT_DIR, '6-rejected-badge.png') })
  check('标记写错时面板给出「被拒」提示（不静默画错）', badgeOk,
    badgeOk ? (await badge.first().textContent()) ?? '' : '未见被拒标签')
  // 恢复正确标记
  await page.locator('button[title="设置"]').first().click()
  await page.waitForTimeout(400)
  await page.locator('.settings-nav button.nav-item', { hasText: '波形解析' }).first().click()
  await page.waitForTimeout(300)
  await prefixInput.click()
  await prefixInput.fill(MARKER)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  // —— 4. 多主题截图 + 标记持久化（reload 后重连） ——
  const origTheme = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('kart:settings') ?? '{}').themeId ?? null) } catch { return null }
  })
  for (const [i, theme] of THEMES.entries()) {
    await page.evaluate((tid) => {
      const s = JSON.parse(localStorage.getItem('kart:settings') ?? '{}')
      s.themeId = tid
      localStorage.setItem('kart:settings', JSON.stringify(s))
    }, theme)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.session-pane').first().waitFor({ timeout: 10000 })
    const reconnected = await connectTcp()
    await page.locator('.dv-tab', { hasText: '波形' }).first().click()
    const lg = await pollLegend((l) => l.length === 2 && l.includes('Temp'))
    const n = await pollPoints()
    const title = `4-theme-${i + 1}-${theme}`
    await page.waitForTimeout(10000) // 同上：让曲线有 10 个点，便于目检
    await page.screenshot({ path: path.join(SHOT_DIR, `${title}.png`) })
    check(
      `主题 ${theme}：重载重连后标记设置仍生效（2 通道且有点）`,
      reconnected && n > 0 && lg.length === 2 && lg.includes('Temp'),
      `通道=${JSON.stringify(lg)} 点数=${n}`
    )
  }
  if (origTheme) {
    await page.evaluate((tid) => {
      const s = JSON.parse(localStorage.getItem('kart:settings') ?? '{}')
      s.themeId = tid
      localStorage.setItem('kart:settings', JSON.stringify(s))
    }, origTheme)
  }

  // —— 5. 常见问题里的绘图格式说明（截图供目检） ——
  await page.locator('.n-button', { hasText: '帮助' }).first().click()
  await page.locator('.n-dropdown-option', { hasText: '常见问题' }).first().click()
  await page.waitForTimeout(600)
  // 条目分页展示，「波形图该打印成什么格式」是第 3 篇（前两篇：macOS 端口 / 无法打开串口）
  for (let i = 0; i < 2; i++) {
    await page.locator('.n-modal button', { hasText: '下一篇' }).first().click()
    await page.waitForTimeout(300)
  }
  const kbShot = page.locator('.n-modal').first()
  await kbShot.screenshot({ path: path.join(SHOT_DIR, '5-knowledge-base-top.png') })
  // 条目比弹窗高：再截一张滚到底的，四条约定表在下方
  await page.evaluate(() => { const b = document.querySelector('.kb-body'); if (b) b.scrollTop = b.scrollHeight })
  await page.waitForTimeout(300)
  await kbShot.screenshot({ path: path.join(SHOT_DIR, '5-knowledge-base-bottom.png') })
  const kbText = (await kbShot.textContent()) ?? ''
  check('常见问题含「绘图格式」条目（标题+四条约定）', kbText.includes('绘图') && kbText.includes('标记'), kbText.slice(0, 60))

  check('无 console/pageerror（已滤 xterm 解析噪声）', errors.length === 0, errors.join('; '))
} catch (e) {
  console.log('FAIL  脚本异常:', e.message)
  fail++
} finally {
  await browser?.close().catch(() => {})
  child.kill('SIGTERM')
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL（截图在 ${SHOT_DIR}/）`)
process.exit(fail > 0 ? 1 : 0)
