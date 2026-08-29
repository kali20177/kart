import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { listThemes } from './registry'

/**
 * 启动加载页（index.html splash）调色板漂移锁定。
 *
 * splash 配色在主 bundle 解析前生效（public/splash-theme.js 同步读 localStorage），
 * 无法复用 TS 侧 registry，只能复制一份调色板。本测试保证两处永不失步：
 * - 每个注册主题在 splash 侧必须有一份调色板（新增主题漏登记会在 CI 拦下）；
 * - 五个字段与主题 tokens 逐字段相等（bg/--bg、fg/--text、dim/--text-dim、
 *   accent/--accent、ok/--ok），改主题色忘改 splash 也会被拦下。
 */
const REPO_ROOT = process.cwd() // vitest 固定以仓库根为 cwd（import.meta.url 经转换不可靠）
const splashSrc = readFileSync(`${REPO_ROOT}/public/splash-theme.js`, 'utf-8')

/** 解析 splash-theme.js 的 PALETTES 字面量：'id': { key: '#hex', ... } */
function parseSplashPalettes(src: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const blockRe = /'([a-z0-9-]+)':\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(src))) {
    const fields: Record<string, string> = {}
    const fieldRe = /(\w+):\s*'(#[0-9a-fA-F]{6})'/g
    let f: RegExpExecArray | null
    while ((f = fieldRe.exec(m[2]))) fields[f[1]] = f[2]
    if (Object.keys(fields).length > 0) out[m[1]] = fields
  }
  return out
}

const TOKEN_FIELD: Record<string, string> = {
  bg: '--bg',
  fg: '--text',
  dim: '--text-dim',
  accent: '--accent',
  ok: '--ok',
}

describe('splash 调色板与主题 registry 同步', () => {
  const palettes = parseSplashPalettes(splashSrc)

  it('splash-theme.js 能解析出调色板（文件结构未被意外破坏）', () => {
    expect(Object.keys(palettes).length).toBeGreaterThanOrEqual(4)
  })

  it('index.html 以相对路径引用 splash-theme.js（dev 与 base ./ 的 prod 均可达）', () => {
    const html = readFileSync(`${REPO_ROOT}/index.html`, 'utf-8')
    expect(html).toContain('src="./splash-theme.js"')
  })

  it('每个注册主题都有 splash 调色板，且五个字段与 tokens 逐字段相等', () => {
    for (const theme of listThemes()) {
      const pal = palettes[theme.id]
      expect(pal, `主题 ${theme.id} 未登记 splash 调色板`).toBeTruthy()
      for (const [field, token] of Object.entries(TOKEN_FIELD)) {
        expect(pal![field], `${theme.id}.${field}`).toBe(theme.tokens[token as keyof typeof theme.tokens])
      }
    }
  })

  it('splash 侧没有 registry 中不存在的孤儿条目', () => {
    const ids = new Set(listThemes().map((t) => t.id))
    for (const id of Object.keys(palettes)) {
      expect(ids.has(id), `splash 调色板含未注册主题 ${id}`).toBe(true)
    }
  })
})
