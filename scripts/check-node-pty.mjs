/**
 * 本地终端（node-pty）prebuilt 自检与修复（postinstall 钩子）。
 *
 * 背景：npm 发布的 node-pty prebuilt 与部分系统不兼容（如 macOS arm64 上
 * spawn 报 `posix_spawnp failed`，无 errno），且 npm install 不会因此失败——
 * prebuild 脚本「下载成功即视为安装完成」，损坏的 binding 在运行时（spawn）
 * 才暴露。本脚本在 postinstall 时真实 spawn 一次探测：失败则自动
 * `node-gyp rebuild`（N-API，产物 Node/Electron 通用）；正常则零开销跳过。
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** probe：加载 node-pty 并 spawn 一个极轻量进程，验证 binding 真实可用（非仅可 require）。 */
function probeOk() {
  // 在子进程内 probe：node-pty 若同步抛错（spawn 失败）→ exit 1；起退异常 → exit 2；
  // 超时无退出 → exit 3；正常起退（exitCode 0）→ exit 0。
  const code = [
    'const pty = require("node-pty")',
    'const exe = process.platform === "win32" ? "cmd.exe" : (process.env.SHELL || "/bin/sh")',
    'const args = process.platform === "win32" ? ["/c", "exit 0"] : ["-c", "exit 0"]',
    'const p = pty.spawn(exe, args, { name: "xterm-256color", cols: 40, rows: 12 })',
    'p.onData(() => {})',
    'p.onExit(({ exitCode }) => process.exit(exitCode === 0 ? 0 : 2))',
    'setTimeout(() => process.exit(3), 8000)',
  ].join('\n')
  try {
    const r = spawnSync(process.execPath, ['-e', code], { timeout: 15000 })
    return r.status === 0
  } catch {
    return false
  }
}

// 定位 node-pty 安装目录；未安装（如仅装了部分依赖）则跳过。
let ptyRoot
try {
  ptyRoot = path.dirname(require.resolve('node-pty/package.json'))
} catch {
  console.log('[check-node-pty] node-pty 未安装，跳过检测')
  process.exit(0)
}

if (probeOk()) {
  console.log('[check-node-pty] node-pty prebuilt 可用')
  process.exit(0)
}

console.log('[check-node-pty] node-pty prebuilt 与当前系统不兼容（或缺失），自动 node-gyp rebuild…')
// Windows 下 npx 是 .cmd，需 shell 启动；macOS/Linux 直接走 PATH（避免 shell 拼接告警）
const r = spawnSync('npx', ['node-gyp', 'rebuild'], {
  cwd: ptyRoot,
  shell: process.platform === 'win32',
  stdio: 'inherit',
})
if (r.status !== 0) {
  console.error(`[check-node-pty] node-gyp rebuild 失败（exit ${r.status}）`)
  console.error('  可手动执行：cd node_modules/node-pty && npx node-gyp rebuild')
  process.exit(r.status || 1)
}
console.log('[check-node-pty] node-pty 本地编译完成')
