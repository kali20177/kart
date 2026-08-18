import { describe, it, expect, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import { createTransferStore } from './transfer'
import type { TransferDeps } from './transfer'
import type { FileTransferConfig, FileTransferState } from '@/types'
import { frameChunk, sliceChunk } from '@/utils/chunk-framer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function cfg(over: Partial<FileTransferConfig>): FileTransferConfig {
  return {
    chunkSize: 256,
    interChunkDelay: 0,
    bytesPerSecond: 0,
    retries: 2,
    framing: 'seq-crc',
    chunkSuffix: 'none',
    waitForAck: true,
    ackMode: 'echo-crc',
    ackByte: 0x06,
    ackTimeout: 20,
    startOffset: 0,
    repeat: 0,
    logEachChunk: false,
    injectCorruptEveryN: 0,
    injectSkipAckEveryN: 0,
    ...over
  }
}

/**
 * 假设备 harness：sendRaw 记录每包 wire；responder 返回设备回包（经 setTimeout(0)
 * 推入，保证 in waitForAck 订阅建立之后到达）。responder 入参为 wire 与尝试次数（1 基）。
 */
function makeHarness(responder?: (wire: Uint8Array, attempt: number) => Uint8Array | null) {
  const connected = ref(true)
  const wires: Uint8Array[] = []
  let dataCb: ((b: Uint8Array) => void) | null = null
  const deps: TransferDeps = {
    sendRaw: async (bytes) => {
      wires.push(bytes)
      if (responder) {
        const resp = responder(bytes, wires.length)
        if (resp) setTimeout(() => dataCb?.(resp), 0)
      }
      return { ok: true }
    },
    onData: (cb) => {
      dataCb = cb
      return () => { dataCb = null }
    },
    connected,
    addFileTransfer: () => {}
  }
  const store = effectScope().run(() => createTransferStore(deps))!
  return { store, wires }
}

async function waitTerminal(store: ReturnType<typeof createTransferStore>, timeoutMs = 3000): Promise<FileTransferState> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const t = store.transfers.value[store.transfers.value.length - 1]
    if (t && ['completed', 'error', 'aborted'].includes(t.status)) return t
    await sleep(5)
  }
  throw new Error(`timed out waiting terminal state; transfers=${store.transfers.value.length}`)
}

function pattern(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(n))
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff
  return bytes
}

// 设备回吐收到的 CRC 尾部（seq-crc 帧最后两字节）
const echoFooter = (wire: Uint8Array) => wire.slice(-2)

describe('transfer store：echo-crc ACK', () => {
  it('设备回吐正确 CRC → 全部完成', async () => {
    const { store, wires } = makeHarness(echoFooter)
    const file = new File([pattern(600)], 'fw.bin') // 600B / 256 = 3 包
    await store.start(file, cfg({}))
    const t = await waitTerminal(store)
    expect(t.status).toBe('completed')
    // 快速传输在 50ms 进度批处理前完成，sent 进度字段不刷新，以真实发出的 wire 断言
    expect(wires.length).toBe(3)
  })

  it('回吐 CRC 不匹配 → 重发本包；第二次正确 → 完成', async () => {
    const { store, wires } = makeHarness((wire, attempt) => {
      if (attempt === 1) {
        const wrong = new Uint8Array(wire.slice(-2))
        wrong[0] ^= 0xff
        return wrong
      }
      return echoFooter(wire)
    })
    const file = new File([pattern(200)], 'fw.bin') // 单包
    await store.start(file, cfg({}))
    const t = await waitTerminal(store)
    expect(t.status).toBe('completed')
    expect(wires.length).toBe(2) // 首包发失败重发一次
  })

  it('设备回 NACK(0x15) → 立即重试；随后正确回吐 → 完成', async () => {
    const { store, wires } = makeHarness((wire, attempt) =>
      attempt === 1 ? new Uint8Array([0x15]) : echoFooter(wire)
    )
    const file = new File([pattern(200)], 'fw.bin')
    await store.start(file, cfg({}))
    const t = await waitTerminal(store)
    expect(t.status).toBe('completed')
    expect(wires.length).toBe(2)
  })

  it('设备不回包 → 超时重试耗尽 → error', async () => {
    const { store, wires } = makeHarness() // 永不回包
    const file = new File([pattern(200)], 'fw.bin')
    await store.start(file, cfg({ retries: 1, ackTimeout: 15 }))
    const t = await waitTerminal(store)
    expect(t.status).toBe('error')
    expect(wires.length).toBe(2) // retries=1 → 尝试 2 次
  })

  it('CRC 破坏（错误注入）→ 回吐比对失败 → 重试耗尽 → error（验证重试闭环）', async () => {
    const { store, wires } = makeHarness(echoFooter) // 设备如实回吐收到的（已被破坏的）CRC
    const file = new File([pattern(400)], 'fw.bin') // 2 包；注入从 chunk 1 开始（chunk 0 保证成功）
    await store.start(file, cfg({ retries: 1, injectCorruptEveryN: 1, chunkSize: 256 }))
    const t = await waitTerminal(store)
    expect(t.status).toBe('error')
    expect(t.failedChunk).toBe(1)
    // chunk0 成功（1 次）+ chunk1 两轮重试均被破坏（2 次）
    expect(wires.length).toBe(3)
  })

  it('byte 模式 ACK 不受重写影响（回归）', async () => {
    const { store, wires } = makeHarness(() => new Uint8Array([0x06]))
    const file = new File([pattern(300)], 'fw.bin')
    await store.start(file, cfg({ ackMode: 'byte', chunkSize: 100 }))
    const t = await waitTerminal(store)
    expect(t.status).toBe('completed')
    expect(wires.length).toBe(3)
  })
})

describe('transfer store：流式读（④）', () => {
  it('fileSource 逐块读的 wire 序列与内存切片参考逐字节一致', async () => {
    const bytes = pattern(1000)
    const { store, wires } = makeHarness()
    const file = new File([bytes], 'fw.bin')
    // 参考序列：用纯函数对内存字节做同样的切片+封装（② 无 ACK，不注入错误）
    const chunkSize = 137
    const expected: Uint8Array[] = []
    for (let i = 0; i < Math.ceil(1000 / chunkSize); i++) {
      expected.push(frameChunk(sliceChunk(bytes, i, chunkSize), i, 'seq-crc', 'none'))
    }
    await store.start(file, cfg({ chunkSize, waitForAck: false, framing: 'seq-crc' }))
    const t = await waitTerminal(store)
    expect(t.status).toBe('completed')
    expect(wires).toEqual(expected)
    expect(wires.length).toBe(expected.length)
    // 负载字节总量 = 文件大小（seq-crc 每帧 4 字节头 + 2 字节 CRC 尾部）
    const payloadBytes = wires.reduce((sum, w) => sum + (w.length - 6), 0)
    expect(payloadBytes).toBe(1000)
  })

  it('按块增量读取：单次读取跨度 ≤ chunkSize，读取次数 == 分块数', async () => {
    const chunkSize = 1024
    const size = chunkSize * 3 + 123 // 4 块（末包 123B）
    const reads: Array<[number, number]> = []
    const origSlice = Blob.prototype.slice
    const spy = vi.spyOn(Blob.prototype, 'slice').mockImplementation(function (this: Blob, start?: number, end?: number) {
      reads.push([start ?? 0, end ?? this.size])
      return origSlice.call(this, start, end)
    })
    try {
      const { store } = makeHarness()
      const file = new File([pattern(size)], 'fw.bin')
      await store.start(file, cfg({ chunkSize, waitForAck: false }))
      const t = await waitTerminal(store)
      expect(t.status).toBe('completed')
      const spans = reads.map(([s, e]) => e - s)
      expect(reads.length).toBe(4)
      expect(Math.max(...spans)).toBe(chunkSize)
      expect(spans.every((n) => n <= chunkSize)).toBe(true)
      // 从未整文件一次读（有界性核心断言）
      expect(spans.some((n) => n === size)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('完成后再 retry：从 File 句柄重读成功（不再依赖整文件驻留内存）', async () => {
    const bytes = pattern(300)
    const { store, wires } = makeHarness()
    const file = new File([bytes], 'fw.bin')
    await store.start(file, cfg({ chunkSize: 100, waitForAck: false }))
    const t1 = await waitTerminal(store)
    expect(t1.status).toBe('completed')
    expect(wires.length).toBe(3)

    await store.retry(t1.id)
    const t2 = await waitTerminal(store)
    expect(t2.status).toBe('completed')
    expect(wires.length).toBe(6) // 重发一遍
  })
})