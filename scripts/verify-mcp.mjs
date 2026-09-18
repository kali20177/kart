/**
 * MCP 服务器端到端验证：驱动 Electron（CDP）开启 MCP server，
 * 再用标准 streamable-http 客户端（fetch 直连）走完整 AI 调试闭环：
 *   list_tools → list_sessions → connect_serial → send_string →
 *   get_recent_messages（读回 TX + RX）→ disconnect。
 *
 * 用法：`ELECTRON=true vite build && node scripts/verify-mcp.mjs`
 * 环境变量：
 *   SERIAL_PORT  要连接的串口（默认 mock /dev/ttyUSB0；
 *                真机填如 /dev/cu.usbmodem2303，此时勿带 ?mock）
 *   SEND_TEXT    发送的文本（默认 AT；真机 shell 可填 help）
 *   MCP_SKIP_UI  1=跳过设置弹窗 UI 目检（默认做）
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'

const require = createRequire(import.meta.url)
// ELECTRON_PATH 允许显式指定二进制（worktree npm i 的 electron 二进制可能未就绪时，
// 用已验证可运行的主 checkout 二进制跑本 worktree 的构建产物）
const electronPath = process.env.ELECTRON_PATH ?? require('electron')
const SHOT_DIR = '/tmp/mcp-verify'
mkdirSync(SHOT_DIR, { recursive: true })

const envSerialPort = process.env.SERIAL_PORT
// KART_MOCK=1 时跑 mock 串口闭环（无硬件 CI 场景）：mock at-reply 场景对 'AT' 回包
const SEND_TEXT = process.env.SEND_TEXT ?? (process.env.KART_MOCK === '1' ? 'AT' : 'help')
const SEND_LINE = process.env.SEND_LINE ?? 'cr'
const PROTOCOL_VERSION = '2025-06-18'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}

delete process.env.ELECTRON_RUN_AS_NODE

// 启动 Electron（prod 构建；串口驱动按环境解析：Electron → serialport 真机）
const CDP_PORT = await getFreePort()
const child = spawn(electronPath, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
})
let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += d })

/** 最小 streamable-http 客户端（SSE/JSON 双 Accept，协议校验由 SDK 服务端完成）。 */
class McpClient {
  constructor(port, token) {
    this.base = `http://127.0.0.1:${port}/mcp`
    this.token = token
    this.sid = null
    this.seq = 0
  }
  async post(body, expectResult = true) {
    const headers = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (this.sid) headers['mcp-session-id'] = this.sid
    const res = await fetch(this.base, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sid = sid
    if (json.error) throw new Error(`MCP 错误: ${JSON.stringify(json.error)}`)
    if (expectResult && json.result === undefined) throw new Error(`无 result: ${JSON.stringify(json)}`)
    return json.result
  }
  async init() {
    await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'verify-mcp', version: '1' } } })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
    return this.sid
  }
  async call(method, params = {}) {
    return this.post({ jsonrpc: '2.0', id: this.seq++, method, params })
  }
}

let browser = null
let page = null
let mcpPort = null
let token = null
try {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(800) })
      if (res.ok) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); break }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!browser) throw new Error(`Electron CDP 未就绪\n--- stderr ---\n${stderrBuf.slice(-1500)}`)
  page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('无窗口页面')
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[renderer:${msg.type()}]`, msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => console.log('[renderer:pageerror]', String(err).slice(0, 300)))
  await page.waitForTimeout(1500) // 等待渲染层桥就绪
  await page.screenshot({ path: `${SHOT_DIR}/00-startup.png` })

  // ── 1. 通过 preload 桥启动 MCP server（真实 IPC 链路）──
  const state = await page.evaluate(async (w) => {
    const info = await window.electron?.mcp?.start({ port: 0, token: null, mode: 'read-write' })
    return info ?? { error: 'window.electron.mcp 不可用（浏览器构建？）' }
  })
  check('preload mcp.start 返回运行状态', !!state?.running, JSON.stringify(state))
  mcpPort = state?.port
  token = state?.token
  if (!mcpPort || !token) throw new Error('MCP server 未运行')

  // ── 2. streamable-http 协议（外部 AI 客户端视角）──
  const c = new McpClient(mcpPort, token)
  const sid = await c.init()
  check('initialize 返回 mcp-session-id', !!sid, sid)

  const tools = await c.call('tools/list')
  const toolNames = tools.tools.map((t) => t.name)
  check('list_tools 含 15 个工具', toolNames.length === 15, `${toolNames.length} 个`)
  for (const need of ['list_serial_ports', 'connect_serial', 'send_string', 'get_recent_messages', 'disconnect']) {
    check(`list_tools 含 ${need}`, toolNames.includes(need))
  }

  const ports = await c.call('tools/call', { name: 'list_serial_ports', arguments: {} })
  const portList = JSON.parse(ports.content[0].text).ports
  // 端口协商：env 显式指定 > rb-demo 真机（/dev/cu.usbmodem2303）> 列表第一个；列表空则该步 FAIL
  const candidates = [envSerialPort, '/dev/cu.usbmodem2303', portList[0]?.path].filter(Boolean)
  const SERIAL_PORT = candidates.find((p) => portList.some((x) => x.path === p))
  check('list_serial_ports 枚举到可用串口', portList.length > 0, portList.map((p) => p.path).join(', '))
  check('目标串口已枚举（真机/USB 设备在位）', !!SERIAL_PORT, `匹配: ${SERIAL_PORT ?? '无'}`)
  if (!SERIAL_PORT) throw new Error('没有可用串口（检查硬件连接后重试）')

  const sessions = await c.call('tools/call', { name: 'list_sessions', arguments: {} })
  const sessionList = JSON.parse(sessions.content[0].text).sessions
  check('list_sessions 至少 1 个会话', sessionList.length >= 1, `sessions=${sessionList.length}`)
  const sessionId = sessionList[0].id

  const conn = await c.call('tools/call', { name: 'connect_serial', arguments: { sessionId, port: SERIAL_PORT } })
  check('connect_serial 连接成功', !conn.isError, conn.content?.[0]?.text)

  const send = await c.call('tools/call', { name: 'send_string', arguments: { sessionId, text: SEND_TEXT, lineEnding: SEND_LINE } })
  check('send_string 发送成功', !send.isError, send.content?.[0]?.text)

  await page.waitForTimeout(1200) // shell 应答 / mock 定时回包
  const msgs = await c.call('tools/call', { name: 'get_recent_messages', arguments: { sessionId, count: 30, mode: 'ascii' } })
  const frames = JSON.parse(msgs.content[0].text).frames
  check('get_recent_messages 读到 TX 帧', frames.some((f) => f.direction === 'tx' && f.ascii.includes(SEND_TEXT)), JSON.stringify(frames.slice(0, 3)))
  const rx = frames.filter((f) => f.direction === 'rx')
  check('设备有应答（RX 帧存在）', rx.length > 0, rx.map((f) => f.ascii).slice(0, 3).join(' | '))

  const dis = await c.call('tools/call', { name: 'disconnect', arguments: { sessionId } })
  check('disconnect 成功', !dis.isError, dis.content?.[0]?.text)

  // ── 3. 设置弹窗 AI tab UI 目检（真实链路：UI 改 mode → useMcpServer → 主进程 server）──
  async function selectMode(labelRe) {
    await page.click('.settings-content .n-base-selection')
    await page.waitForTimeout(250)
    await page.locator('.n-base-select-option', { hasText: labelRe }).first().click()
  }
  if (process.env.MCP_SKIP_UI !== '1') {
    await page.click('.global-btn.icon-btn')
    await page.waitForTimeout(400)
    const nav = await page.$$eval('.settings-nav .nav-item', (els) => els.map((e) => e.textContent?.trim()))
    check('设置弹窗含 AI（MCP）导航', nav.some((n) => n.includes('AI') || n.includes('MCP')), nav.join('/'))
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.settings-nav .nav-item')]
      const ai = items.find((e) => (e.textContent ?? '').includes('AI') || (e.textContent ?? '').includes('MCP'))
      ai?.click()
    })
    await page.waitForTimeout(300)
    // 先切关闭再切读写：每次都值变化 → settings watch 触发 → 主进程同步（确定性）
    await selectMode(/关|Off/)
    await page.waitForTimeout(500)
    await selectMode(/读写|Read-Write/)
    await page.waitForTimeout(900)

    const pane = await page.$eval('.settings-content', (el) => (el.textContent ?? '').replace(/\s+/g, ' '))
    check('AI tab 渲染模式选择', pane.includes('服务模式') || pane.includes('Service Mode'), pane.slice(0, 60))
    check('AI tab 显示运行状态', pane.includes('运行中') || pane.includes('Running on'), pane.slice(0, 80))
    const urlVal = await page.$eval('.settings-content input[readonly]', (el) => el.value)
    check('AI tab 显示端点 URL', urlVal.includes('/mcp'), urlVal)
    check('AI tab 显示访问令牌', pane.includes('Bearer') || pane.includes('令牌'), pane.slice(0, 80))
    await page.screenshot({ path: `${SHOT_DIR}/01-mcp-settings-tab.png` })
  } else {
    console.log('SKIP  设置弹窗 UI 目检（MCP_SKIP_UI=1）')
  }

  // ── 4. 只读模式 gate（重启为 read-only 验证写工具被拒）──
  await page.evaluate(() => window.electron?.mcp?.stop())
  const ro = await page.evaluate(() => window.electron?.mcp?.start({ port: 0, token: null, mode: 'read-only' }))
  check('read-only 模式启动成功', !!ro?.running)
  const c2 = new McpClient(ro.port, ro.token)
  await c2.init()
  const denied = await c2.call('tools/call', { name: 'send_string', arguments: { sessionId, text: 'x' } })
  check('read-only 拒绝写工具', denied.isError === true && denied.content[0].text.includes('permission denied'), denied.content?.[0]?.text)
  await page.evaluate(() => window.electron?.mcp?.stop())

  // ── 5. 恢复关闭：e2e 把 settings.mcp.mode 改成了 read-write，切回 off 保持用户环境干净 ──
  if (process.env.MCP_SKIP_UI !== '1') {
    await selectMode(/关|Off/)
    await page.waitForTimeout(500)
  }

  await page.screenshot({ path: `${SHOT_DIR}/02-final.png` })
  console.log(`\nMCP 验证完成：${pass} 通过 / ${fail} 失败（截图 ${SHOT_DIR}/）`)
} finally {
  await browser?.close().catch(() => {})
  child.kill()
}
setTimeout(() => { process.exit(fail > 0 ? 1 : 0) }, 300)