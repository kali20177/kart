import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { IFileWriter } from '@/composables/useFileWriter'

const mockWriter: IFileWriter = {
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getFileName: vi.fn().mockReturnValue('test-log.txt')
}

let shouldCancel = false
let shouldFailWrite = false

vi.mock('@/composables/useFileWriter', () => ({
  createFileWriter: () => ({
    open: async (_name: string, _format: string) => {
      if (shouldCancel) return null
      if (shouldFailWrite) {
        return {
          write: vi.fn().mockRejectedValue(new Error('ENOSPC')),
          close: vi.fn().mockResolvedValue(undefined),
          getFileName: () => 'test.txt'
        }
      }
      return mockWriter
    }
  })
}))

async function setupStores() {
  const { useSerialStore } = await import('./serial')
  const { useRecorderStore } = await import('./recorder')

  const serial = useSerialStore()
  const recorder = useRecorderStore()

  // Capture callbacks registered via onData/onTxData
  const rxCallbacks: Array<(bytes: Uint8Array) => void> = []
  const txCallbacks: Array<(bytes: Uint8Array) => void> = []

  vi.spyOn(serial, 'onData').mockImplementation((cb) => {
    rxCallbacks.push(cb)
    return () => {
      const idx = rxCallbacks.indexOf(cb)
      if (idx >= 0) rxCallbacks.splice(idx, 1)
    }
  })
  vi.spyOn(serial, 'onTxData').mockImplementation((cb) => {
    txCallbacks.push(cb)
    return () => {
      const idx = txCallbacks.indexOf(cb)
      if (idx >= 0) txCallbacks.splice(idx, 1)
    }
  })

  return { serial, recorder, rxCallbacks, txCallbacks }
}

describe('recorder store', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    shouldCancel = false
    shouldFailWrite = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in idle state', async () => {
    const { recorder } = await setupStores()
    expect(recorder.state.status).toBe('idle')
    expect(recorder.isRecording).toBe(false)
  })

  it('start() opens file writer and enters recording state', async () => {
    const { recorder } = await setupStores()
    await recorder.start({ format: 'text' })
    expect(recorder.state.status).toBe('recording')
    expect(recorder.state.fileName).toBe('test-log.txt')
  })

  it('start() does nothing if user cancels save dialog', async () => {
    shouldCancel = true
    const { recorder } = await setupStores()
    await recorder.start({ format: 'text' })
    expect(recorder.state.status).toBe('idle')
  })

  it('start() is no-op if already recording', async () => {
    const { recorder } = await setupStores()
    await recorder.start({ format: 'text' })
    await recorder.start({ format: 'text' })
    expect(recorder.state.status).toBe('recording')
  })

  it('stop() closes writer and returns to idle', async () => {
    const { recorder } = await setupStores()
    await recorder.start({ format: 'text' })
    await recorder.stop()
    expect(mockWriter.close).toHaveBeenCalled()
    expect(recorder.state.status).toBe('idle')
  })

  it('buffers bytes and flushes at size threshold', async () => {
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start({ format: 'text' })

    // Feed a chunk larger than 64KB through the registered RX callback
    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))

    // Should have triggered a write
    expect(mockWriter.write).toHaveBeenCalled()
  })

  it('write error sets error status', async () => {
    shouldFailWrite = true
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start({ format: 'text' })

    // Feed a chunk that triggers the size-threshold flush
    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))

    // Flush is async (fire-and-forget from ingest), wait for microtask queue
    await new Promise(r => setTimeout(r, 50))

    // The flush should have failed and set error status
    expect(recorder.state.status).toBe('error')
  })

  it('stop() from error state works', async () => {
    shouldFailWrite = true
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start({ format: 'text' })

    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))

    // Wait for async flush to complete and set error status
    await new Promise(r => setTimeout(r, 50))

    await recorder.stop()
    expect(recorder.state.status).toBe('idle')
  })
})
