import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref, computed } from 'vue'
import type { IFileWriter } from '@/composables/useFileWriter'

const mockWriter: IFileWriter = {
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getFileName: vi.fn().mockReturnValue('test-log.txt')
}

const mockDirName = ref<string | null>('test-dir')
const mockIsConfigured = computed(() => mockDirName.value !== null)

let mockCreateFile = vi.fn().mockResolvedValue(mockWriter)
let mockPick = vi.fn().mockResolvedValue(undefined)

vi.mock('@/composables/useRecordDirectory', () => ({
  useRecordDirectory: () => ({
    dirName: mockDirName,
    isConfigured: mockIsConfigured,
    pick: mockPick,
    clear: vi.fn(),
    createFile: mockCreateFile
  })
}))

async function setupStores() {
  const { useSerialStore } = await import('./serial')
  const { useRecorderStore } = await import('./recorder')
  const { useSettingsStore } = await import('./settings')

  const serial = useSerialStore()
  const settings = useSettingsStore()
  const recorder = useRecorderStore()

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

  return { serial, settings, recorder, rxCallbacks, txCallbacks }
}

describe('recorder store', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockCreateFile = vi.fn().mockResolvedValue(mockWriter)
    mockDirName.value = 'test-dir'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in idle state', async () => {
    const { recorder } = await setupStores()
    expect(recorder.state.status).toBe('idle')
    expect(recorder.isRecording).toBe(false)
  })

  it('start() creates file and enters recording state', async () => {
    const { recorder, settings } = await setupStores()
    settings.settings.recordFormat = 'text'
    await recorder.start()
    expect(recorder.state.status).toBe('recording')
    expect(mockCreateFile).toHaveBeenCalledOnce()
  })

  it('start() throws if no directory configured', async () => {
    mockDirName.value = null
    const { recorder } = await setupStores()
    await expect(recorder.start()).rejects.toThrow()
    expect(recorder.state.status).toBe('idle')
  })

  it('start() is no-op if already recording', async () => {
    const { recorder } = await setupStores()
    await recorder.start()
    await recorder.start()
    expect(mockCreateFile).toHaveBeenCalledTimes(1)
  })

  it('stop() closes writer and returns to idle', async () => {
    const { recorder } = await setupStores()
    await recorder.start()
    await recorder.stop()
    expect(mockWriter.close).toHaveBeenCalled()
    expect(recorder.state.status).toBe('idle')
  })

  it('buffers bytes and flushes at size threshold', async () => {
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start()

    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))

    expect(mockWriter.write).toHaveBeenCalled()
  })

  it('write error sets error status', async () => {
    const errorWriter: IFileWriter = {
      write: vi.fn().mockRejectedValue(new Error('ENOSPC')),
      close: vi.fn().mockResolvedValue(undefined),
      getFileName: vi.fn().mockReturnValue('test.bin')
    }
    mockCreateFile = vi.fn().mockResolvedValue(errorWriter)

    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start()

    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))

    await new Promise(r => setTimeout(r, 50))
    expect(recorder.state.status).toBe('error')
  })

  it('stop() from error state works', async () => {
    const errorWriter: IFileWriter = {
      write: vi.fn().mockRejectedValue(new Error('ENOSPC')),
      close: vi.fn().mockResolvedValue(undefined),
      getFileName: vi.fn().mockReturnValue('test.bin')
    }
    mockCreateFile = vi.fn().mockResolvedValue(errorWriter)

    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start()

    const bigChunk = new Uint8Array(65 * 1024)
    rxCallbacks.forEach(cb => cb(bigChunk))
    await new Promise(r => setTimeout(r, 50))

    await recorder.stop()
    expect(recorder.state.status).toBe('idle')
  })
})
