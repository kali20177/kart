import { describe, it, expect } from 'vitest'
import { memorySource, fileSource } from './chunk-source'

function pattern(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(n))
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff
  return bytes
}

describe('chunk-source', () => {
  it('memorySource 切片字节正确', async () => {
    const src = memorySource(pattern(10))
    expect(src.size).toBe(10)
    expect([...await src.slice(2, 5)]).toEqual([...pattern(10).slice(2, 5)])
  })

  it('fileSource 与 memorySource 切片字节一致（jsdom 走 FileReader 兜底路径）', async () => {
    const bytes = pattern(300)
    const file = new File([bytes], 't.bin')
    const fs = fileSource(file)
    const ms = memorySource(bytes)
    expect(fs.size).toBe(300)
    // 覆盖整包、首块、末块短包
    for (const [s, e] of [[0, 300], [0, 128], [256, 300], [0, 1]] as const) {
      expect([...await fs.slice(s, e)]).toEqual([...await ms.slice(s, e)])
    }
  })

  it('重复随机切片读取结果一致（jsdom Blob 不可变，无法做「文件变更反映」断言）', async () => {
    const bytes = pattern(64)
    const file = new File([bytes], 't.bin')
    const src = fileSource(file)
    expect([...(await src.slice(0, 64))]).toEqual([...bytes])
    expect([...(await src.slice(10, 20))]).toEqual([...bytes.slice(10, 20)])
  })
})
