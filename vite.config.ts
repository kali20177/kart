import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath, URL } from 'node:url'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

// 仅当 ELECTRON=true 时激活 Electron 插件；
// 普通 `vite` / `vite build`（浏览器构建）下完全惰性，产物与现状一致。
const isElectron = process.env.ELECTRON === 'true'

// 防御：某些机器全局设置了 ELECTRON_RUN_AS_NODE=1（如 STM32 等工具链），
// 它会让 Electron 退化为纯 Node 运行，require('electron') 只返回可执行文件路径，
// 导致 app/BrowserWindow 为 undefined。Electron 按「变量是否存在」判断，cross-env
// 置空/置 0 均无效，必须删除。在此删除可让 vite-plugin-electron 在 dev 下 spawn 的
// Electron 子进程继承到干净的环境。无该变量的机器上此操作是无害的 no-op。
if (isElectron) {
  delete process.env.ELECTRON_RUN_AS_NODE
}

// 「关于」对话框用的构建期信息（参考 VSCode：版本 / 提交 / 构建日期 / 依赖版本）。
const requirePkg = createRequire(import.meta.url)
const pkg = requirePkg('./package.json')
const depVersion = (name: string): string => {
  try {
    return requirePkg(`${name}/package.json`).version
  } catch {
    return 'unknown'
  }
}
let gitCommit = 'unknown'
try {
  gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch {
  // 非 git 环境或未安装 git：保持 'unknown'
}
const buildInfo = {
  version: pkg.version as string,
  commit: gitCommit,
  date: new Date().toISOString(),
  deps: {
    vue: depVersion('vue'),
    pinia: depVersion('pinia'),
    'naive-ui': depVersion('naive-ui'),
    vite: depVersion('vite'),
    electron: depVersion('electron')
  }
}

export default defineConfig({
  // file:// 加载需相对路径；浏览器构建保持绝对根路径。
  base: isElectron ? './' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(buildInfo.version),
    __GIT_COMMIT__: JSON.stringify(buildInfo.commit),
    __BUILD_DATE__: JSON.stringify(buildInfo.date),
    __DEP_VERSIONS__: JSON.stringify(buildInfo.deps)
  },
  plugins: [
    vue(),
    // 预编译 i18n 消息 + 切到 vue-i18n 运行时构建（无 new Function/eval）。
    // 项目 CSP 为 script-src 'self'（禁 unsafe-eval），必须避免运行时消息编译。
    VueI18nPlugin({
      include: [fileURLToPath(new URL('./src/locales/**', import.meta.url))],
      runtimeOnly: true
    }),
    ...(isElectron
      ? [
          electron({
            main: {
              entry: 'src/main/index.ts',
              vite: {
                build: {
                  outDir: 'dist-electron/main',
                  // 强制 CJS：Electron 主进程以 ESM 导入 CJS 的 electron 模块在
                  // type:module 下会触发 Node ESM 互操作错误。lib:false 覆盖插件
                  // 默认的 lib(['es'])，改由 rollupOptions 产出 .cjs。
                  lib: false,
                  rollupOptions: {
                    input: 'src/main/index.ts',
                    output: { format: 'cjs', entryFileNames: 'index.cjs' },
                    // serialport / @serialport/* 含运行时动态 require 的原生 .node
                    // 向量，不能被打进 bundle（路径会失效）。external 后在运行时由
                    // Node 从打包应用内的 node_modules 解析，配合 electron-builder 的
                    // asarUnpack 把 .node 解出 asar。
                    external: ['serialport', /^@serialport\//]
                  }
                }
              }
            },
            preload: {
              input: 'src/preload/index.ts',
              vite: {
                build: {
                  outDir: 'dist-electron/preload',
                  rollupOptions: {
                    output: { format: 'cjs', entryFileNames: 'index.cjs' }
                  }
                }
              }
            }
          })
        ]
      : [])
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5273
  },
  test: {
    environment: 'jsdom',
    // Node 22+ 在 globalThis 上装了实验性 localStorage 访问器，会遮蔽 jsdom 的
    // Web Storage 实现（见 src/test/setup.ts 头注释），故仍需 setup 文件提供。
    setupFiles: ['./src/test/setup.ts'],
    globals: true
  }
})
