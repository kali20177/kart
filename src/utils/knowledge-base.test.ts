import { describe, it, expect } from 'vitest'
import { i18n } from '@/i18n'
import { KB_ENTRIES } from './knowledge-base'

const LOCALES = ['zh-CN', 'en-US'] as const

describe('knowledge-base · RS-232 信号线条目', () => {
  const entry = KB_ENTRIES.find((e) => e.id === 'rs232-signals')
  if (!entry) throw new Error('rs232-signals 条目缺失')

  it('表格块结构完整（3 列表头 + 4 行），全部 cell 的 i18n key 两语言均可解析', () => {
    const table = entry.blocks.find((b) => b.type === 'table')!.table!
    expect(table.headers).toHaveLength(3)
    expect(table.rows).toHaveLength(4)
    expect(table.rows.every((r) => r.length === table.headers.length)).toBe(true)

    const keys = [...table.headers, ...table.rows.flat()]
    for (const locale of LOCALES) {
      i18n.global.locale = locale
      for (const k of keys) {
        const resolved = i18n.global.t(k)
        expect(resolved, `${locale} 未能解析 ${k}`).toBeTruthy()
        expect(resolved, `${locale} 的 ${k} 命中原样 key`).not.toBe(k)
      }
    }
  })

  it('标题/摘要与正文段落两语言均可解析', () => {
    const textKeys = entry.blocks.filter((b) => b.type === 'text').map((b) => b.text!)
    const all = [entry.titleKey, entry.summaryKey, ...textKeys, entry.blocks.find((b) => b.type === 'link')!.text!]
    for (const locale of LOCALES) {
      i18n.global.locale = locale
      for (const k of all) {
        const resolved = i18n.global.t(k)
        expect(resolved, `${locale} 未能解析 ${k}`).toBeTruthy()
        expect(resolved, `${locale} 的 ${k} 命中原样 key`).not.toBe(k)
      }
    }
  })
})
