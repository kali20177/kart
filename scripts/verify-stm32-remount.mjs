/**
 * 真机验证：布局重挂载后 xterm 不再孤儿化（修复 ensureOpen 迁移 term.element）。
 * 用户完整流程：重载 → 选 2303（restoreLayout 重挂载，终端自动激活）→ 连接 →
 * 免点击直接打字（用户踩坑路径）→ 点已激活 tab → 打字。同时回归点终端区域路径。
 *
 * 往返证据：打 `led off/on/blinky`（stm32f103-zephyr-demo 的 shell 命令）断言设备侧
 * 应答 `led: xx`——该字符串只有 Zephyr shell 会打印，不依赖本地回显设置；固件较旧
 * 没有 led 命令时兜底断言 `uart:~$` 提示符重打（shell 处理完一行必回提示符）。
 * 用法：KART_CDP=http://127.0.0.1:9333 node scripts/verify-stm32-remount.mjs /tmp/stm-remount-fix
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const SHOT_DIR = process.argv[2] || '/tmp/stm-remount-fix'
mkdirSync(SHOT_DIR, { recursive: true })
const CDP = process.env.KART_CDP || 'http://127.0.0.1:9333'
const log = (...a) => console.log(...a)
let fail = 0
const check = (name, ok, extra = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) fail++
}

const browser = await chromium.connectOverCDP(CDP)
const page = browser.contexts()[0]?.pages()[0]
if (!page) { console.error('无窗口页面'); process.exit(1) }
await page.reload()
await page.waitForLoadState('domcontentloaded', { timeout: 15000 })
await page.waitForTimeout(2500)

const xtermDom = () => page.evaluate(() => ({
  rows: document.querySelectorAll('.xterm-rows').length,
  ta: document.querySelectorAll('.xterm-helper-textarea').length,
  taConnected: [...document.querySelectorAll('.xterm-helper-textarea')].every((t) => t.isConnected),
  focused: !!document.activeElement?.classList?.contains('xterm-helper-textarea'),
  active: document.activeElement?.className?.slice?.(0, 60) ?? '',
  activeTab: [...document.querySelectorAll('.view-tab.active')].map((e) => e.textContent?.trim().slice(0, 6)),
  status: document.querySelector('.status')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}))
const termText = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '')

/** 打一行命令并断言设备侧往返：应答字符串（首选）或提示符重打（兜底）。
 *  两者都只有设备能产生，与本地回显设置无关；打字渲染不再作为判据——
 *  本地+设备双回显会把文本叠加成 'lleedd oofff'，属环境噪声而非失败。 */
async function typeAndCheck(label, cmd, reply) {
  const promptsBefore = ((await termText()).match(/uart:~\$/g) ?? []).length
  await page.keyboard.type(cmd)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const dom = await xtermDom()
  const text = await termText()
  const replied = text.includes(reply)
  const promptsAfter = (text.match(/uart:~\$/g) ?? []).length
  check(
    `${label} 设备往返（${reply}）`,
    replied || promptsAfter > promptsBefore,
    replied ? `focused=${dom.focused}` : `提示符 ${promptsBefore}→${promptsAfter}（兜底证据，固件可能无 led 命令）`
  )
}

log('== S0 重载后（全新会话）==')
let s = await xtermDom()
log('  dom:', JSON.stringify(s))

log('== S1 选 2303（触发 restoreLayout 重挂载）==')
const portSel = page.locator('.n-base-selection', { hasText: /选择端口|2303|usbserial|\// }).first()
await portSel.click()
const opt = page.locator('.n-base-select-option:visible', { hasText: 'usbmodem2303' }).first()
await opt.waitFor({ timeout: 5000 })
await opt.click()
await page.waitForTimeout(2000)
s = await xtermDom()
check('S1a xterm DOM 存在且连接', s.rows > 0 && s.ta > 0 && s.taConnected, `rows=${s.rows} ta=${s.ta}`)
check('S1b 终端为活动视图', s.activeTab.includes('终端×'), JSON.stringify(s.activeTab))
await page.screenshot({ path: path.join(SHOT_DIR, 's1-after-port-switch.png') })

log('== S2 连接 ==')
// 上轮脚本可能残留已连接会话，reload 关闭端口有异步释放窗口，连接做有限重试
for (let i = 0; i < 3; i++) {
  await page.locator('button', { hasText: '连接' }).first().click({ timeout: 5000 })
  const ok = await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false)
  if (ok) break
  log(`  （第 ${i + 1} 次连接未成功，重试）`)
  const dis = page.locator('button', { hasText: '断开' }).first()
  if (await dis.isVisible().catch(() => false)) { await dis.click(); await page.waitForTimeout(1500) }
  await page.waitForTimeout(1500)
}
await page.locator('button', { hasText: '断开' }).first().waitFor({ timeout: 10000 })
await page.waitForTimeout(2000) // 等 DTR 排空/欢迎文本稳定
s = await xtermDom()
check('S2a 连接后 xterm DOM 仍在', s.rows > 0 && s.taConnected, `rows=${s.rows}`)
const t0 = await termText()
log(`  终端文本 len=${t0.length} tail=${JSON.stringify(t0.slice(-60))}`)
await page.screenshot({ path: path.join(SHOT_DIR, 's2-connected.png') })

log('== S3 连接后免点击直接打字（用户踩坑路径）==')
// 设备应答 = 打字进了 xterm 且 Enter 到达设备（聚焦滞留/孤儿化问题在此暴露）
await typeAndCheck('S3 免点击打字', 'led off', 'led: off')
await page.screenshot({ path: path.join(SHOT_DIR, 's3-type-no-click.png') })

log('== S4 点击已激活终端 tab 后打字 ==')
await page.locator('.dv-tab', { hasText: '终端' }).first().click()
await page.waitForTimeout(1200)
s = await xtermDom()
check('S4a 点已激活 tab 后 xterm 聚焦', s.focused, `active=${s.active.slice(0, 50)}`)
await typeAndCheck('S4b', 'led on', 'led: on')
await page.screenshot({ path: path.join(SHOT_DIR, 's4-after-active-tab-click.png') })

log('== S5 点击终端区域（对照路径）==')
await page.locator('.term-pane .viewport').first().click()
await page.waitForTimeout(600)
s = await xtermDom()
check('S5a 点终端区域后 xterm 聚焦', s.focused, `active=${s.active.slice(0, 50)}`)
await typeAndCheck('S5b', 'led blinky', 'led: blinky')
await page.screenshot({ path: path.join(SHOT_DIR, 's5-click-viewport.png') })

log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`)
// 收尾断开：避免端口句柄残留（reload 不走应用销毁链，主进程会报「串口已被占用」）
try {
  const dis = page.locator('button', { hasText: '断开' }).first()
  if (await dis.isVisible()) { await dis.click(); await page.waitForTimeout(800) }
} catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
