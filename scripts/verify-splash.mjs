/**
 * 启动加载页回归：主题自适应调色板 + 全屏无边距（白边）+ fallback。
 *
 * A. 浏览器矩阵（playwright + 系统 Chrome + dev vite）：route 延迟 /src/main.ts
 *    让 splash 停留可见，逐主题断言 loader 背景与该主题 --bg 一致、loader 铺满视口、
 *    body margin=0；未知 themeId 断言回落 glass-industrial-dark 默认。
 *    （浏览器 localStorage 与用户 Electron 数据隔离，主题可随意切换。）
 * B. Electron prod 冒烟（本仓库 dist 构建、不改动用户设置）：file:// 下
 *    ./splash-theme.js 必须可达——documentElement 上 --splash-bg 非空。
 *
 * 用法：`node scripts/verify-splash.mjs`（需先 `ELECTRON=true vite build` 跑 B 部分）。
 */
import { chromium } from "playwright-core"
import net from "node:net"
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VITE_PORT = 5273
const VITE = `http://localhost:${VITE_PORT}`

// light 打头：全新 profile 下 dark 是默认主题，setTheme(dark) 为无操作、设置不落盘，
// 落盘轮询会超时；从 light 起步的每次切换都是真实变更
const EXPECT = {
  'glass-industrial-light': '#f4f6fa',
  'glass-industrial-dark': '#0d1117',
  'oled-hud': '#050508',
  'retro-console': '#0d1024',
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// —— A. 浏览器矩阵 ——
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  await page.goto(`${VITE}/?mock`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__theme, null, { timeout: 15000 })
  await sleep(300)

  // 计算样式返回 rgb() 形式，期望值统一转成 rgb 串再比
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  }

  for (const [id, bg] of Object.entries(EXPECT)) {
    const wantRgb = hexToRgb(bg)
    await page.evaluate((tid) => window.__theme.setTheme(tid), id)
    // 设置持久化有延迟：轮询确认 themeId 已落盘再 reload，否则 splash 读到旧值
    await page.waitForFunction(
      (tid) => { try { return JSON.parse(localStorage.getItem('kart:settings') ?? '{}').themeId === tid } catch { return false } },
      id,
      { timeout: 5000 }
    )
    // 延迟主入口 → splash 停留可见。注意 DCL 会等模块脚本执行完，
    // reload 须以 commit 返回后轮询 splash 出现，否则 app 已挂载、splash 已被替换
    await page.route('**/src/main.ts*', async (route) => {
      await sleep(2600)
      await route.continue()
    })
    await page.reload({ waitUntil: 'commit' })
    const hasLoader = await page
      .waitForSelector('.app-loader', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)

    const info = await page.evaluate(() => {
      const loader = document.querySelector('.app-loader')
      const box = loader?.getBoundingClientRect()
      return {
        loaderBg: loader ? getComputedStyle(loader).backgroundColor : 'N/A',
        splashTheme: document.documentElement.getAttribute('data-splash-theme') ?? '(无)',
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyMargin: getComputedStyle(document.body).margin,
        box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        vp: { w: window.innerWidth, h: window.innerHeight },
        hasWave: !!document.querySelector('.app-loader-wave-path'),
        title: document.querySelector('.app-loader-title')?.textContent ?? 'N/A',
      }
    })
    check(`[${id}] splash 出现（main.ts 已被延迟）`, hasLoader, hasLoader ? '' : '等待 .app-loader 超时')
    check(`[${id}] 主题标记正确`, info.splashTheme === id, info.splashTheme)
    check(`[${id}] splash 背景随主题`, info.loaderBg === wantRgb, `bg=${info.loaderBg} 期望=${wantRgb}`)
    check(`[${id}] html 背景同步（无白边缝隙）`, info.htmlBg === wantRgb, info.htmlBg)
    check(`[${id}] body margin=0`, info.bodyMargin === '0px', info.bodyMargin)
    check(
      `[${id}] loader 铺满视口`,
      info.box && info.box.x === 0 && info.box.y === 0 && info.box.w === info.vp.w && info.box.h === info.vp.h,
      JSON.stringify(info.box)
    )
    check(`[${id}] 波形动画就位`, info.hasWave)
    check(`[${id}] 标题为 KART`, info.title === 'KART', info.title)
    await page.screenshot({ path: `/tmp/splash-verify/${id}.png` }).catch(() => {})
    await page.unroute('**/src/main.ts*')
    await page.waitForSelector('.session-pane', { timeout: 20000 })
  }

  // 未知 themeId → 回落 glass-industrial-dark 默认（直改 settings 字段，随后恢复）
  const orig = await page.evaluate(() => localStorage.getItem('kart:settings'))
  await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('kart:settings') ?? '{}')
    cfg.themeId = 'no-such-theme'
    localStorage.setItem('kart:settings', JSON.stringify(cfg))
  })
  await page.route('**/src/main.ts*', async (route) => {
    await sleep(2600)
    await route.continue()
  })
  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('.app-loader', { timeout: 5000 })
  const fallback = await page.evaluate(() => ({
    splashTheme: document.documentElement.getAttribute('data-splash-theme') ?? '(无)',
    bg: getComputedStyle(document.querySelector('.app-loader')).backgroundColor,
  }))
  check('未知 themeId 标记 fallback', fallback.splashTheme === 'fallback', fallback.splashTheme)
  check('未知 themeId 回落默认暗色', fallback.bg === 'rgb(13, 17, 23)', fallback.bg)
  await page.screenshot({ path: '/tmp/splash-verify/fallback.png' }).catch(() => {})
  await page.unroute('**/src/main.ts*')
  if (orig !== null) await page.evaluate((o) => localStorage.setItem('kart:settings', o), orig)
  await page.waitForSelector('.session-pane', { timeout: 20000 })
} catch (e) {
  console.error('脚本异常(A):', e.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
  vite.kill('SIGTERM')
}

// —— B. Electron prod 冒烟：file:// 下 splash-theme.js 可达（不改用户设置） ——
delete process.env.ELECTRON_RUN_AS_NODE
const electronPath = require('electron')
function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
const CDP_PORT_B = await getFreePort()
const electron = spawn(electronPath, ['.', `--remote-debugging-port=${CDP_PORT_B}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderrBuf = ''
electron.stderr.on('data', (d) => { stderrBuf += d })
try {
  let eBrowser = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT_B}/json`, { signal: AbortSignal.timeout(700) })
      if (res.ok) { eBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT_B}`); break }
    } catch { /* 未就绪 */ }
    await sleep(300)
  }
  if (!eBrowser) throw new Error(`Electron CDP 未就绪\n--- stderr ---\n${stderrBuf.slice(-800)}`)
  const ePage = eBrowser.contexts()[0]?.pages()[0]
  await ePage.waitForSelector('.session-pane', { timeout: 20000 })
  // file:// 与 dev http:// 的 localStorage 是不同 origin（prod 通常无设置 → fallback），
  // 断言「脚本已执行且有生效主题」而非具体某个主题：data-splash-theme 非空即脚本可达
  const splashState = await ePage.evaluate(() => ({
    marker: document.documentElement.getAttribute('data-splash-theme') ?? '(无)',
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  }))
  const okMarker = splashState.marker === 'fallback' || EXPECT[splashState.marker] !== undefined
  const wantBg =
    splashState.marker === 'fallback'
      ? 'rgb(13, 17, 23)'
      : splashState.marker !== '(无)'
        ? (() => { const n = parseInt(EXPECT[splashState.marker].slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})` })()
        : ''
  check('Electron prod（file://）splash 主题脚本可达', okMarker, `marker=${splashState.marker} htmlBg=${splashState.htmlBg}`)
  check('Electron prod（file://）splash 底色与标记一致', splashState.htmlBg === wantBg, `${splashState.htmlBg} 期望=${wantBg}`)
  await eBrowser.close().catch(() => {})
} catch (e) {
  console.error('脚本异常(B):', e.message)
  check('Electron prod（file://）splash 主题脚本可达', false, e.message.split('\n')[0])
}
electron.kill('SIGTERM')

console.log(`\n====  ${pass} passed, ${fail} failed  ====`)
if (fail > 0) process.exitCode = 1
