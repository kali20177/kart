import { beforeEach, vi } from 'vitest'

/**
 * 为什么需要这个文件
 * ------------------
 * `vite.config.ts` 里 `test.environment: 'jsdom'` 实际上是生效的（userAgent 为
 * jsdom/24.x，window/document 均可用）。但 Node 22+ 在 `globalThis` 上装了一个
 * 实验性的 `localStorage` 访问器（`--experimental-webstorage`），它是一个 own
 * property，遮蔽了 jsdom 的 Web Storage：
 *
 *   - vitest 1.6.1 的 jsdom 环境只把 jsdom window 的「自有可枚举属性」拷到全局，
 *     而 jsdom 的 `localStorage` 位于原型链上，不会被拷贝；
 *   - 于是全局 `localStorage` 命中 Node 的实验性访问器，getter 返回 undefined 并
 *     抛 `ExperimentalWarning: localStorage is not available because
 *     --localstorage-file was not provided`。
 *
 * 根因不是 `defineConfig` 的导入来源（从 'vite' 还是 'vitest/config' 导入在运行时
 * 都会原样透传 `test` 字段），也不是 environment 没生效。最稳妥、可跨 Node 版本的
 * 修法是在 setup 里提供一个内存版 localStorage（等价于 jsdom 的语义，但不依赖
 * Node 标志位）。`vi.stubGlobal` 能覆盖 Node 的访问器（serial.spec.ts 早已如此）。
 *
 * 每个 test 前 reset 一次，保证用例间隔离（store 持久化测试依赖干净的初始状态）。
 */
beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, String(v)),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    get length() {
      return memory.size
    }
  })
})
