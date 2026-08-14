/**
 * 本地终端（node-pty）端到端验证：prod 构建 + KART_PTY=1 启动 Electron，
 * 连接 local-shell → 终端视图 → 验证 shell 交互与 vim 全屏渲染。
 *
 * 用法：`node scripts/verify-pty.mjs`（需先 `ELECTRON=true vite build`）。
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const SHOT_DIR = '/tmp/pty-verify'
mkdirSync(SHOT_DIR, { recursive: true })

/** 取一个空闲端口，避免残留 Electron 实例占用固定 CDP 端口导致启动冲突 */
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

/** 读取 xterm DOM 渲染的可见文本（xterm 用 DOM 渲染器时 canvas 不存在） */
async function termText(page) {
  return page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '')
}

/** 轮询等待 xterm 可见文本满足谓词（shell prompt / 命令输出） */
async function waitTermText(page, pred, timeout = 8000) {
  const start = Date.now()
  let text = ''
  while (Date.now() - start < timeout) {
    text = await termText(page)
    if (pred(text)) return text
    await page.waitForTimeout(200)
  }
  return text
}

// 某些机器全局设置了 ELECTRON_RUN_AS_NODE=1（如 STM32 工具链），会让 Electron 退化
// 为纯 Node 运行（require('electron') 只返回路径、app 为 undefined）。必须删除。
delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, KART_PTY: '1' }
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
  if (!browser) {
    throw new Error(`Electron CDP 未就绪\n--- electron stderr ---\n${stderrBuf.slice(-1500)}`)
  }

  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('无窗口页面')
  // 尽早注册，捕获全流程（挂载/prompt/ls/vim）的渲染进程错误，而非仅尾部
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 })

  // 等端口列表就绪（pty 驱动 listPorts 返回 local-shell）→ 点击连接
  await page.getByRole('button', { name: '连接' }).click({ timeout: 10000 })
  await page.getByRole('button', { name: '断开' }).waitFor({ timeout: 10000 })
  check('点击连接 → 已连接态（驱动=pty，shell 已 spawn）', true)

  // 切「终端」视图
  await page.locator('.dv-tab', { hasText: '终端' }).click({ timeout: 5000 })
  await page.locator('.xterm-screen').waitFor({ timeout: 8000 })
  check('终端视图 xterm 挂载 (.xterm-screen)', true)

  // 等待 shell prompt 渲染（可见文本含 shell 提示符特征）
  const promptText = await waitTermText(page, (t) => /[$%#➜>]/.test(t) && t.trim().length > 0)
  check('shell prompt 渲染（xterm 可见文本）', /[$%#➜>]/.test(promptText), `文本片段=${JSON.stringify(promptText.slice(0, 60))}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '1-prompt.png') })

  // char 直通：输入命令 → shell 回显
  const termInput = page.locator('.xterm-helper-textarea')
  await termInput.click()
  const beforeLs = (await termText(page)).length
  await page.keyboard.type('ls\r')
  await page.waitForTimeout(1500)
  const afterLs = await termText(page)
  check('输入 ls 后屏幕文本增长（命令回显 + 输出）', afterLs.length > beforeLs + 5, `Δ=${afterLs.length - beforeLs} 片段=${JSON.stringify(afterLs.slice(0, 50))}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '2-ls.png') })

  // vim 全屏（alt-screen）
  await termInput.click()
  await page.keyboard.type('vim\r')
  const vimText = await waitTermText(page, (t) => t.includes('~') || /vim/i.test(t), 8000)
  check('vim 启动后全屏渲染（含 ~ 空行标记或 vim 特征）', vimText.includes('~') || /vim/i.test(vimText), `片段=${JSON.stringify(vimText.slice(0, 60))}`)
  await page.screenshot({ path: path.join(SHOT_DIR, '3-vim.png') })

  // 退出 vim
  await termInput.click()
  await page.keyboard.type(':q\r')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(SHOT_DIR, '4-exit-vim.png') })

  check('无 console/pageerror', errors.length === 0, errors.join('; '))
} catch (e) {
  console.log('FAIL  脚本异常:', e.message)
  fail++
} finally {
  await browser?.close().catch(() => {})
  child.kill('SIGTERM')
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL（截图在 ${SHOT_DIR}/）`)
process.exit(fail > 0 ? 1 : 0)
