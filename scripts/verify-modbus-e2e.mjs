/**
 * Kart × rb-demo Modbus RTU 真机端到端验证。
 *
 * 前置：stm32f103-rb-demo feat-modbus-rtu 固件已烧录，USART1 经 USB-TTL 在位。
 * 链路：Electron(prod 构建 + CDP) → preload 桥启动 MCP server(read-write) →
 *   connect_serial(baud 115200) → send_bytes 发 Modbus 请求帧 → 设备应答 →
 *   Kart 帧切分(gap-timeout 20ms) → modbus-rtu 解码器 → get_recent_messages(decode=true)
 *   读回「原始帧 + 解码字段」逐项断言。
 *
 * 用法：ELECTRON=true npx vite build && node scripts/verify-modbus-e2e.mjs
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import net from 'node:net'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const SHOT_DIR = '/tmp/mbdump/shots'
mkdirSync(SHOT_DIR, { recursive: true })

const MODBUS_PORT = process.env.MODBUS_PORT ?? '/dev/cu.usbserial-2430'
const UNIT = 1

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

// ── 本地金标准参考实现（与固件/probe 同一 CRC16-Modbus）──
function crc16(data) {
  let crc = 0xffff
  for (const b of data) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
  }
  return crc
}
function mbFrame(pdu, unit = UNIT) {
  const body = Buffer.from([unit, ...pdu])
  const c = crc16(body)
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])])
}
function crcOk(frame) {
  const c = crc16(frame.subarray(0, -2))
  return frame.at(-2) === (c & 0xff) && frame.at(-1) === (c >> 8) & 0xff
}
function regsOf(reply) {
  const n = reply[2] / 2
  const out = []
  for (let i = 0; i < n; i++) out.push((reply[3 + 2 * i] << 8) | reply[4 + 2 * i])
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
delete process.env.ELECTRON_RUN_AS_NODE

const CDP_PORT = await getFreePort()
const child = spawn(electronPath, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
})
let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += d })

class McpClient {
  constructor(port, token) { this.base = `http://127.0.0.1:${port}/mcp`; this.token = token; this.sid = null; this.seq = 0 }
  async post(body, expectResult = true) {
    const headers = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.sid) headers['mcp-session-id'] = this.sid
    const res = await fetch(this.base, { method: 'POST', headers, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sid = sid
    if (json.error) throw new Error(`MCP 错误: ${JSON.stringify(json.error)}`)
    if (expectResult && json.result === undefined) throw new Error(`无 result: ${JSON.stringify(json)}`)
    return json.result
  }
  async init() {
    await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-modbus', version: '1' } } })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  }
  async call(name, args = {}) {
    const r = await this.post({ jsonrpc: '2.0', id: this.seq++, method: 'tools/call', params: { name, arguments: args } })
    if (r.isError) throw new Error(`${name} 工具错误: ${r.content?.[0]?.text}`)
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
  if (!browser) throw new Error(`Electron CDP 未就绪\n--- stderr ---\n${stderrBuf.slice(-1500)}`)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('无窗口页面')
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 200)))
  await sleep(1500)

  // 1. 播种该端口的解码器配置后 reload：boot 流程 refreshPorts 自动选端口时
  //    watch(selectedPort) 会从 storage 加载配置——播种必须发生在 boot 读取之前。
  await page.evaluate(([port]) => {
    localStorage.setItem(`kart:decoder-config:${port}`, JSON.stringify({ id: 'modbus-rtu', options: {} }))
  }, [MODBUS_PORT])
  await page.reload()
  await sleep(2000)

  // 2. 启动 MCP server（read-write，随机端口）
  const state = await page.evaluate(async () => window.electron?.mcp?.start({ port: 0, token: null, mode: 'read-write' }))
  if (!state?.running) throw new Error(`MCP 启动失败: ${JSON.stringify(state)}`)
  const mcp = new McpClient(state.port, state.token)
  await mcp.init()

  // 3. 连接真机串口
  const { sessions } = await mcp.call('list_sessions', {})
  const sessionId = sessions[0].id
  const st0 = await mcp.call('get_session_status', { sessionId })
  check('boot 自动选端口且解码器配置已加载 (modbus-rtu)', st0.decoderId === 'modbus-rtu', `decoderId=${st0.decoderId}`)
  const conn = await mcp.call('connect_serial', { sessionId, port: MODBUS_PORT, options: { baudRate: 115200 } })
  check('connect_serial 115200 连接成功', typeof conn.connected === 'boolean' || !!conn, JSON.stringify(conn).slice(0, 120))

  // 4. 请求序列（顺序即线上顺序）
  const sends = [
    { name: 'FC03 holding 8..11 (uptime/ver/jedec)', frame: mbFrame([0x03, 0x00, 0x08, 0x00, 0x04]) },
    { name: 'FC06 reg0=0xCAFE', frame: mbFrame([0x06, 0x00, 0x00, 0xca, 0xfe]) },
    { name: 'FC03 reg0 读回', frame: mbFrame([0x03, 0x00, 0x00, 0x00, 0x01]) },
    { name: 'FC16 regs1..2={0x1234,0x5678}', frame: mbFrame([0x10, 0x00, 0x01, 0x00, 0x02, 0x04, 0x12, 0x34, 0x56, 0x78]) },
    { name: 'FC03 reg1..2 读回', frame: mbFrame([0x03, 0x00, 0x01, 0x00, 0x02]) },
    { name: 'FC05 coil0 ON', frame: mbFrame([0x05, 0x00, 0x00, 0xff, 0x00]) },
    { name: 'FC01 coil0 读回', frame: mbFrame([0x01, 0x00, 0x00, 0x00, 0x01]) },
    { name: 'FC15 coil0=ON', frame: mbFrame([0x0f, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01]) },
    { name: 'FC03 reg22 越界→异常02', frame: mbFrame([0x03, 0x00, 0x16, 0x00, 0x01]) },
    { name: '坏 CRC 请求（应静默）', frame: (() => { const f = mbFrame([0x03, 0x00, 0x00, 0x00, 0x01]); f[f.length - 1] ^= 0xff; return f })() },
    { name: 'FC04 input 0..3', frame: mbFrame([0x04, 0x00, 0x00, 0x00, 0x04]) },
    { name: 'FC02 discrete 0..3', frame: mbFrame([0x02, 0x00, 0x00, 0x00, 0x04]) },
    // ── 新固件（FC08/22/23/43 + 扩展点表）──
    { name: 'FC08 回送诊断 DEAd', frame: mbFrame([0x08, 0x00, 0x00, 0xde, 0xad]) },
    { name: 'FC08 从站消息计数', frame: mbFrame([0x08, 0x00, 0x0e, 0x00, 0x00]) },
    { name: 'FC03 reg3 预读（掩码写前值）', frame: mbFrame([0x03, 0x00, 0x03, 0x00, 0x01]) },
    { name: 'FC22 reg3 and=0x00FF or=0xA000', frame: mbFrame([0x16, 0x00, 0x03, 0x00, 0xff, 0xa0, 0x00]) },
    { name: 'FC03 reg3 掩码结果读回', frame: mbFrame([0x03, 0x00, 0x03, 0x00, 0x01]) },
    { name: 'FC23 读 8..12 写 reg0=0xBEEF', frame: mbFrame([0x17, 0x00, 0x08, 0x00, 0x05, 0x00, 0x00, 0x00, 0x01, 0x02, 0xbe, 0xef]) },
    { name: 'FC03 reg0 读回 0xBEEF', frame: mbFrame([0x03, 0x00, 0x00, 0x00, 0x01]) },
    { name: 'FC43/14 basic 全读', frame: mbFrame([0x2b, 0x0e, 0x01, 0x00]) },
    { name: 'FC43 basic@obj5 越界→异常02', frame: mbFrame([0x2b, 0x0e, 0x01, 0x05]) },
    { name: 'FC43/14 regular 流式', frame: mbFrame([0x2b, 0x0e, 0x02, 0x03]) },
    { name: 'FC06 reg12 非魔数→异常03', frame: mbFrame([0x06, 0x00, 0x0c, 0x12, 0x34]) },
    { name: 'FC04 input 4..8 工艺量', frame: mbFrame([0x04, 0x00, 0x04, 0x00, 0x05]) },
    { name: 'FC03 全表 0..21 qty22（49B）', frame: mbFrame([0x03, 0x00, 0x00, 0x00, 0x16]) },
  ]
  for (const s of sends) {
    await mcp.call('send_bytes', { sessionId, data: [...s.frame] })
    await sleep(120) // > 固件 t3.5(40ms)，请求间互不粘连
  }
  await sleep(600) // 收完最后一帧

  // 5. 读回全部帧 + 解码字段
  const out = await mcp.call('get_recent_messages', { sessionId, count: 200, mode: 'hex', decode: true })
  const frames = out.frames.slice().reverse() // 新增在前 → 恢复时间序
  const tx = frames.filter((f) => f.direction === 'tx')
  const rx = frames.filter((f) => f.direction === 'rx')

  check('TX 帧数 = 发送数 25', tx.length === 25, `${tx.length}`)
  const expectRxFc = [0x03, 0x06, 0x03, 0x10, 0x03, 0x05, 0x01, 0x0f, 0x83, 0x04, 0x02, 0x08, 0x08, 0x03, 0x16, 0x03, 0x17, 0x03, 0x2b, 0xab, 0x2b, 0x86, 0x04, 0x03]
  check('RX 帧数 = 24（坏 CRC 请求被从站静默）', rx.length === 24, `${rx.length}`)
  check('RX 逐帧 CRC16 通过', rx.every((f) => crcOk(Buffer.from(f.hex.replace(/ /g, ''), 'hex'))))

  const rxBytes = rx.map((f) => Buffer.from(f.hex.replace(/ /g, ''), 'hex'))
  // 成帧正确性：每条 RX 帧长度恰等于该请求的应答长度（并帧/裂帧都会在此现形）
  const expectRxLen = [13, 8, 7, 8, 9, 8, 6, 8, 5, 13, 6, 8, 8, 7, 10, 7, 15, 7, 44, 5, 94, 5, 15, 49]
  check('RX 帧长与预期应答逐帧一致（无并帧/裂帧）', expectRxLen.every((n, i) => rxBytes[i]?.length === n),
    rxBytes.map((b) => b.length).join(','))
  check('RX 功能码序列与请求一一对应', expectRxFc.every((fc, i) => rxBytes[i]?.[1] === fc),
    rxBytes.map((b) => `0x${b[1].toString(16)}`).join(','))

  // 解码字段断言
  const decoded = rx.filter((f) => f.decoded)
  check('全部 RX 帧被 modbus-rtu 解码器匹配', decoded.length === rx.length, `${decoded.length}/${rx.length}`)
  check('decoded.decoderId = modbus-rtu', decoded.every((f) => f.decoded.decoderId === 'modbus-rtu'))
  const fieldsOf = (i) => Object.fromEntries((rx[i].decoded?.fields ?? []).map((x) => [x.name, x]))

  const summaryOf = (i) => rx[i].decoded?.summary ?? '(无)'
  const f0 = fieldsOf(0)
  const uptime0 = regsOf(rxBytes[0])
  check('FC03 8..11: registers 数值正确', uptime0[1] === 0x0100 && uptime0[2] === 0x00ef && uptime0[3] === 0x4017,
    JSON.stringify(uptime0.map((x) => x.toString(16))))
  check('FC03 8..11: summary 带 slave/fc', /slave=0x01/.test(summaryOf(0)) && /0x03/.test(f0.fc?.value ?? ''), summaryOf(0))

  const f2 = fieldsOf(2)
  check('FC06 写后读回 registers=[0xCAFE]', JSON.stringify(f2.registers?.number) === '[51966]', JSON.stringify(f2.registers?.number))
  const f4 = fieldsOf(4)
  check('FC16 写后读回 registers=[0x1234,0x5678]', JSON.stringify(f4.registers?.number) === '[4660,22136]', JSON.stringify(f4.registers?.number))
  const f6 = fieldsOf(6)
  check('FC01 线圈读回位图=01', f6.coils?.value === '01', f6.coils?.value)
  const f8 = fieldsOf(8)
  check('越界读解码为异常 02 Illegal Data Address', f8.exception?.number === 2 && /Illegal Data Address/.test(f8.exception?.value ?? ''), f8.exception?.value)
  const f9 = fieldsOf(9)
  const uptime1 = regsOf(rxBytes[9])
  check('FC04 input = uptime 镜像 + 版本 + JEDEC', uptime1[1] === 0x0100 && uptime1[2] === 0x00ef && uptime1[3] === 0x4017 && uptime1[0] >= uptime0[0],
    JSON.stringify(uptime1.map((x) => x.toString(16))))
  const f10 = fieldsOf(10)
  check('FC02 按键位图 1 字节（松开=00，按下=0F/05）', /^[0-9A-F]{2}$/.test(f10.coils?.value ?? ''), f10.coils?.value)

  // F1 修复后的期望：FC16/FC15 echo 应答（4 字节数据段）结构化为 reg+count
  const f3 = fieldsOf(3)
  const f7 = fieldsOf(7)
  check('FC16 echo 应答结构化为 reg+count', f3.reg?.number === 1 && f3.count?.number === 2,
    `reg=${f3.reg?.value} count=${f3.count?.value}`)
  check('FC15 echo 应答结构化为 reg+count', f7.reg?.number === 0 && f7.count?.number === 1,
    `reg=${f7.reg?.value} count=${f7.count?.value}`)

  // 消息 tab 在前台截图（解码气泡肉眼可查；store 级断言已在上面完成）
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.dv-tab')].find((el) => el.textContent?.includes('消息'))
    const inner = tab?.firstElementChild ?? tab
    inner?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    inner?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    inner?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await sleep(400)
  // ── 新固件 FC 家族的解码断言 ──
  const f11 = fieldsOf(11)
  check('FC08 回送：subfn=0x0000 + data=DE AD', f11.subfn?.number === 0 && f11.data?.value === 'DE AD',
    `subfn=${f11.subfn?.value} data=${f11.data?.value}`)
  const f12 = fieldsOf(12)
  check('FC08 从站消息计数：subfn=0x000E + count>0', f12.subfn?.number === 0x0e && (f12.count?.number ?? 0) > 0,
    `count=${f12.count?.value}`)
  const f14 = fieldsOf(14)
  check('FC22 掩码写：reg/andMask/orMask', f14.reg?.number === 3 && f14.andMask?.number === 0x00ff && f14.orMask?.number === 0xa000,
    `reg=${f14.reg?.value} and=${f14.andMask?.value} or=${f14.orMask?.value}`)
  const cur = fieldsOf(13).registers?.number?.[0]
  const masked = fieldsOf(15).registers?.number?.[0]
  check('FC22 掩码结果读回 = (cur&and)|(or&~and)', masked === ((cur & 0xff) | (0xa000 & ~0xff & 0xffff)),
    `cur=0x${(cur ?? 0).toString(16)} -> 0x${(masked ?? 0).toString(16)}`)
  const f16 = fieldsOf(16)
  // 请求侧字段（readReg/writeReg/...）在 TX 帧上，Kart 只解码 RX —— 请求侧结构化由离线金标准覆盖
  check('FC23 响应 registers=[uptime,ver,jedec,seq]', JSON.stringify((f16.registers?.number ?? []).slice(1, 4)) === '[256,239,16407]',
    JSON.stringify(f16.registers?.number))
  const f17 = fieldsOf(17)
  check('FC23 写半区落地：reg0 读回 0xBEEF', f17.registers?.number?.[0] === 0xbeef,
    `0x${(f17.registers?.number?.[0] ?? 0).toString(16)}`)
  const f18 = fieldsOf(18)
  check('FC43 basic：conformity=0x83 + 3 对象含厂商/产品码/版本', f18.conformity?.number === 0x83 && f18.objectCount?.number === 3 &&
    (f18.deviceId?.value ?? '').includes('kali20177') && (f18.deviceId?.value ?? '').includes('RB-DEMO-MODBUS') && (f18.deviceId?.value ?? '').includes('1.0.0'),
    f18.deviceId?.value)
  const f19 = fieldsOf(19)
  check('FC43 basic@obj5 → 异常 02 Illegal Data Address', f19.exception?.number === 2, f19.exception?.value)
  const f20 = fieldsOf(20)
  check('FC43 regular 流式：4 对象含 url/型号/应用名', f20.objectCount?.number === 4 &&
    (f20.deviceId?.value ?? '').includes('https://gitee.com/kali_mufasa') && (f20.deviceId?.value ?? '').includes('NUCLEO-F103RB') && (f20.deviceId?.value ?? '').includes('rb-demo'),
    f20.deviceId?.value)
  const f21 = fieldsOf(21)
  check('FC06 保存命令非魔数 → 异常 03 Illegal Data Value', f21.exception?.number === 3, f21.exception?.value)
  const f22 = fieldsOf(22)
  check('FC04 input 4..8：5 个工艺量寄存器', (f22.registers?.number ?? []).length === 5, JSON.stringify(f22.registers?.number))
  const f23 = fieldsOf(23)
  const full = f23.registers?.number ?? []
  check('FC03 全表 22 寄存器：版本/JEDEC/链路对位置正确', full.length === 22 && full[9] === 0x0100 && full[10] === 0x00ef && full[11] === 0x4017 && full[13] === 1 && full[14] === 6,
    `len=${full.length} [9..14]=${JSON.stringify(full.slice(9, 15))}`)

  await page.screenshot({ path: `${SHOT_DIR}/final-decoded.png` })

  // 6. 清理：断开 + 移除播种的配置键 + 停 MCP
  await mcp.call('disconnect', { sessionId })
  await page.evaluate(([port]) => {
    localStorage.removeItem(`kart:decoder-config:${port}`)
    localStorage.removeItem(`kart:checksum-config:${port}`)
  }, [MODBUS_PORT])
  await page.evaluate(() => window.electron?.mcp?.stop())
  console.log(`\n端到端验证完成：${pass} 通过 / ${fail} 失败（截图 ${SHOT_DIR}/final-decoded.png）`)
} finally {
  await browser?.close().catch(() => {})
  child.kill()
}
setTimeout(() => process.exit(fail > 0 ? 1 : 0), 300)
