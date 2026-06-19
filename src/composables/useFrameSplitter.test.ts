import { describe, it, expect } from 'vitest'
import { FrameSplitter } from '@/composables/useFrameSplitter'
import type { FrameConfig } from '@/types'

const base: FrameConfig = { strategy: 'gap-timeout', gapMs: 20, delimiterHex: '0D0A', fixedLength: 4 }

describe('FrameSplitter gap-timeout', () => {
  it('间隔小于 gap 合并，超过则切帧', () => {
    const fs = new FrameSplitter({ ...base, strategy: 'gap-timeout', gapMs: 20 })
    expect(fs.push(new Uint8Array([1, 2]), 0)).toEqual([])
    // 10ms 后再来，<20ms 合并
    expect(fs.push(new Uint8Array([3]), 10)).toEqual([])
    // 100ms 后再来，>20ms → 先切出前一帧 [1,2,3]
    const out = fs.push(new Uint8Array([9]), 100)
    expect(out.length).toBe(1)
    expect(Array.from(out[0])).toEqual([1, 2, 3])
    // flush 取尾帧 [9]
    const tail = fs.flush()
    expect(Array.from(tail[0])).toEqual([9])
  })
})

describe('FrameSplitter delimiter', () => {
  it('按 0D0A 切分并保留分隔符', () => {
    const fs = new FrameSplitter({ ...base, strategy: 'delimiter', delimiterHex: '0D0A' })
    const out = fs.push(new Uint8Array([0x41, 0x0d, 0x0a, 0x42]), 0)
    expect(out.length).toBe(1)
    expect(Array.from(out[0])).toEqual([0x41, 0x0d, 0x0a])
    // 余下 [0x42] 留在 buffer
    const out2 = fs.push(new Uint8Array([0x0d, 0x0a]), 1)
    expect(Array.from(out2[0])).toEqual([0x42, 0x0d, 0x0a])
  })
})

describe('FrameSplitter fixed-length', () => {
  it('每 4 字节一帧，余数留存', () => {
    const fs = new FrameSplitter({ ...base, strategy: 'fixed-length', fixedLength: 4 })
    const out = fs.push(new Uint8Array([1, 2, 3, 4, 5, 6]), 0)
    expect(out.length).toBe(1)
    expect(Array.from(out[0])).toEqual([1, 2, 3, 4])
    const out2 = fs.push(new Uint8Array([7, 8]), 1)
    expect(Array.from(out2[0])).toEqual([5, 6, 7, 8])
  })
})
