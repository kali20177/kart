import { describe, it, expect, afterEach } from 'vitest'
import { listSystemFonts } from './fonts'

interface Face { family: string }
function installQuery(fn: () => Promise<Face[]>) {
  ;(window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts = fn
}

afterEach(() => {
  delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts
})

describe('listSystemFonts', () => {
  it('去重并排序 family（同一 family 多个 style 合并）', async () => {
    installQuery(async () => [
      { family: 'Menlo' },
      { family: 'Courier New' },
      { family: 'Menlo' },
      { family: 'Arial' },
    ])
    expect(await listSystemFonts()).toEqual(['Arial', 'Courier New', 'Menlo'])
  })

  it('无 queryLocalFonts API（非 Chromium / 非安全上下文）时返回空', async () => {
    expect(await listSystemFonts()).toEqual([])
  })

  it('API 抛错（权限被拒）时返回空', async () => {
    installQuery(async () => {
      throw new Error('Permission denied')
    })
    expect(await listSystemFonts()).toEqual([])
  })

  it('空 family 被过滤', async () => {
    installQuery(async () => [
      { family: 'Menlo' },
      { family: '' },
      { family: 'Arial' },
    ])
    expect(await listSystemFonts()).toEqual(['Arial', 'Menlo'])
  })
})
