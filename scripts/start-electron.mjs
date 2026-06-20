// 启动已构建的 Electron 应用（用于 electron:preview）。
// 删除 ELECTRON_RUN_AS_NODE 后再 spawn —— 某些机器全局设置了该变量（=1），
// 会让 Electron 退化为纯 Node 运行。Electron 按变量是否存在判断，必须删除而非置空。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// electron 包的入口导出其可执行文件的绝对路径。
const electronPath = require('electron')

delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})

child.on('close', (code) => process.exit(code ?? 0))
