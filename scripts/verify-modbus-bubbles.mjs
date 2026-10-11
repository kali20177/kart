/**
 * 气泡溢出检查：发宽值帧（全表 22 寄存器 / FC43 流式识别 / 普通读对照），
 * 量化每个解码字段芯片是否超出气泡边界。修复前后各跑一次对比。
 * 用法：ELECTRON=true npx vite build && node /tmp/mbdump/bubble-check.mjs
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const MODBUS_PORT = '/dev/cu.usbserial-2430'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function crc16(data) {
  let crc = 0xffff
  for (const b of data) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
  }
  return crc
}
function mbFrame(pdu, unit = 1) {
  const body = Buffer.from([unit, ...pdu])
  const c = crc16(body)
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])])
}
function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
delete process.env.ELECTRON_RUN_AS_NODE

const CDP_PORT = await getFreePort()
const child = spawn(electronPath, ['.', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' })

class McpClient {
  constructor(port, token) { this.base = `http://127.0.0.1:${port}/mcp`; this.token = token; this.sid = null; this.seq = 0 }
  async post(body, expectResult = true) {
    const headers = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.sid) headers['mcp-session-id'] = this.sid
    const res = await fetch(this.base, { method: 'POST', headers, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sid = sid
    if (json.error) throw new Error(JSON.stringify(json.error))
    if (expectResult && json.result === undefined) throw new Error('no result')
    return json.result
  }
  async init() {
    await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bubble-check', version: '1' } } })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  }
  async call(name, args = {}) {
    const r = await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'tools/call', params: { name, arguments: args } })
    if (r.isError) throw new Error(r.content?.[0]?.text)
    return JSON.parse(r.content[0].text)
  }
}

let browser = null
try {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(800) })
      if (res.ok) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); break }
    } catch { /* 未就绪 */ }
    await sleep(300)
  }
  const page = browser.contexts()[0]?.pages()[0]
  await sleep(1500)
  await page.evaluate(([port]) => {
    localStorage.setItem(`kart:decoder-config:${port}`, JSON.stringify({ id: 'modbus-rtu', options: {} }))
  }, [MODBUS_PORT])
  await page.reload()
  await sleep(2000)

  const state = await page.evaluate(async () => window.electron?.mcp?.start({ port: 0, token: null, mode: 'read-write' }))
  const mcp = new McpClient(state.port, state.token)
  await mcp.init()
  const { sessions } = await mcp.call('list_sessions', {})
  const sessionId = sessions[0].id
  await mcp.call('connect_serial', { sessionId, port: MODBUS_PORT, options: { baudRate: 115200 } })

  const sends = [
    ['FC03 8..11 常规宽', mbFrame([0x03, 0x00, 0x08, 0x00, 0x04])],
    ['FC03 全表 22 寄存器（最宽 registers）', mbFrame([0x03, 0x00, 0x00, 0x00, 0x16])],
    ['FC43 流式识别（最宽 deviceId）', mbFrame([0x2b, 0x0e, 0x02, 0x03])],
    ['FC16 写 8 寄存器（最宽请求 data）', mbFrame([0x10, 0x00, 0x00, 0x00, 0x08, 0x10, 0x10, 0x00, 0x10, 0x01, 0x10, 0x02, 0x10, 0x03, 0x10, 0x04, 0x10, 0x05, 0x10, 0x06, 0x10, 0x07])],
  ]
  for (const [, f] of sends) {
    await mcp.call('send_bytes', { sessionId, data: [...f] })
    await sleep(150)
  }
  await sleep(500)

  // 切到消息 tab
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.dv-tab')].find((el) => el.textContent?.includes('消息'))
    const inner = tab?.firstElementChild ?? tab
    inner?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    inner?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await sleep(400)

  const report = await page.evaluate(() => {
    const out = []
    for (const chip of document.querySelectorAll('.decoded-field')) {
      const bubble = chip.closest('.bubble')
      if (!bubble) continue
      const c = chip.getBoundingClientRect()
      const b = bubble.getBoundingClientRect()
      const over = Math.round(c.right - b.right)
      out.push({
        name: chip.querySelector('.fname')?.textContent,
        chipW: Math.round(c.width),
        bubbleW: Math.round(b.width),
        overflowRight: over,
        overflowLeft: Math.round(b.left - c.left),
        text: (chip.querySelector('.fval')?.textContent ?? '').slice(0, 40)
      })
    }
    return out
  })
  for (const r of report) {
    const flag = r.overflowRight > 1 || r.overflowLeft > 1 ? 'OVERFLOW' : 'ok'
    console.log(`${flag}  ${r.name}  chip=${r.chipW}px bubble=${r.bubbleW}px right=+${r.overflowRight} left=+${r.overflowLeft}  "${r.text}"`)
  }
  const nOver = report.filter((r) => r.overflowRight > 1 || r.overflowLeft > 1).length
  console.log(`\n${nOver} 个芯片溢出 / ${report.length} 个芯片`)

  await page.screenshot({ path: process.argv[2] ?? '/tmp/mbdump/shots/bubble-before.png' })

  // ── 多主题目检：UI 切主题（单连接零 reload——reload 会残留主进程串口句柄）──
  const OPTION_LABELS = ['glass-industrial-dark', 'glass-industrial-light', 'mondrian', 'oled-hud', 'retro-console'] // 注册表序
  const gear = page.locator('.global-btn.icon-btn')
  const msgTab = () => page.evaluate(() => {
    const tab = [...document.querySelectorAll('.dv-tab')].find((el) => el.textContent?.includes('消息'))
    const inner = tab?.firstElementChild ?? tab
    inner?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    inner?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await gear.click()
  await sleep(400)
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.settings-nav .nav-item')].find((el) => el.textContent?.includes('显示'))
    item?.click()
  })
  await sleep(300)
  const themeItem = page.locator('.n-form-item', { has: page.locator('.n-form-item-label', { hasText: '主题' }) }).first()
  const themeSelect = themeItem.locator('.n-base-selection')
  const origLabel = (await themeSelect.textContent() ?? '').trim()
  console.log('初始主题:', origLabel)
  for (let i = 0; i < OPTION_LABELS.length; i++) {
    if (i > 0) {
      await gear.click() // 上一轮 Escape 已关弹窗，重新打开
      await sleep(400)
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.settings-nav .nav-item')].find((el) => el.textContent?.includes('显示'))
        item?.click()
      })
      await sleep(300)
    }
    await themeSelect.click()
    await sleep(350)
    const opt = page.locator('.n-base-select-option').nth(i)
    const label = (await opt.textContent() ?? '').trim()
    await opt.click()
    await sleep(500)
    await page.keyboard.press('Escape') // 关设置弹窗（下拉已随选项点击收起）
    await sleep(300)
    await msgTab()
    await sleep(300)
    await page.screenshot({ path: `/tmp/mbdump/shots/bubble-theme-${OPTION_LABELS[i]}.png` })
    console.log(`theme ${i}: ${label} -> bubble-theme-${OPTION_LABELS[i]}.png`)
  }
  // 恢复原主题
  await gear.click()
  await sleep(400)
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.settings-nav .nav-item')].find((el) => el.textContent?.includes('显示'))
    item?.click()
  })
  await sleep(300)
  await themeSelect.click()
  await sleep(350)
  await page.locator('.n-base-select-option', { hasText: origLabel }).first().click()
  await sleep(300)
  await page.keyboard.press('Escape')
  await sleep(200)

  await mcp.call('disconnect', { sessionId })
  await page.evaluate(([port]) => localStorage.removeItem(`kart:decoder-config:${port}`), [MODBUS_PORT])
  await page.evaluate(() => window.electron?.mcp?.stop())
} finally {
  await browser?.close().catch(() => {})
  child.kill()
}
setTimeout(() => process.exit(0), 300)
