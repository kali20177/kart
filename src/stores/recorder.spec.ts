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
const mockPick = vi.fn().mockResolvedValue(undefined)

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

  it('file name includes sanitized port, stream key passed for multi-session isolation', async () => {
    const { serial, recorder, settings } = await setupStores()
    settings.settings.recordFormat = 'text'
    serial.selectedPort = '/dev/cu.usbserial-2430'
    await recorder.start()
    // 文件名带端口（/ 已替换为 -），createFile 第二参为 streamKey——主进程按 (窗口, streamKey) 分流的键
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.stringMatching(/^serial-log-dev-cu\.usbserial-2430-\d{8}-\d{6}\.txt$/),
      'dev-cu.usbserial-2430'
    )
  })

  it('no port falls back to no-port in file name', async () => {
    const { recorder, settings } = await setupStores()
    settings.settings.recordFormat = 'text'
    await recorder.start()
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.stringMatching(/^serial-log-no-port-\d{8}-\d{6}\.txt$/),
      'no-port'
    )
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

  it('buffer overflow sets error and subsequent ingest is no-op', async () => {
    vi.useFakeTimers()
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start()

    // 单次注入足够大的原始数据：格式化后 ~18MB 超过 16MB 硬上限。
    // 小 chunk 逐步累积会被 64KB 大小阈值 flush 清空，无法触发硬上限。
    const hugeChunk = new Uint8Array(6 * 1024 * 1024)
    rxCallbacks.forEach(cb => cb(hugeChunk))
    // flushBuffer 是异步的，推进微任务
    await vi.advanceTimersByTimeAsync(0)

    expect(recorder.state.status).toBe('error')
    expect(recorder.state.error).toContain('录制已停止')

    // 之后 ingest 因 status !== 'recording' 直接返回
    const statusAfter = recorder.state.status
    rxCallbacks.forEach(cb => cb(new Uint8Array(1024)))
    expect(recorder.state.status).toBe(statusAfter) // 仍是 error
    vi.useRealTimers()
  })

  it('handlePageHide cleans up subscriptions and attempts flush', async () => {
    const { recorder, rxCallbacks, txCallbacks } = await setupStores()
    await recorder.start()

    // 注入一些数据到缓冲区
    const chunk = new Uint8Array(1024)
    rxCallbacks.forEach(cb => cb(chunk))
    txCallbacks.forEach(cb => cb(chunk))

    // 派发 pagehide 事件
    window.dispatchEvent(new Event('pagehide'))

    // pagehide 后订阅已清理——再注入数据不应进缓冲区
    const writeCountBefore = vi.mocked(mockWriter.write).mock.calls.length
    rxCallbacks.forEach(cb => cb(chunk))
    expect(vi.mocked(mockWriter.write).mock.calls.length).toBe(writeCountBefore)
  })

  it('handlePageHide flushes remaining buffer and closes writer', async () => {
    const { recorder, rxCallbacks } = await setupStores()
    await recorder.start()

    // 注入数据（不足 64KB 阈值，不会提前触发 flush——数据留在缓冲区）
    const chunk = new Uint8Array(1024)
    rxCallbacks.forEach(cb => cb(chunk))

    // 派发 pagehide：应把残留缓冲 flush 到文件并真正 close writer
    window.dispatchEvent(new Event('pagehide'))

    // flushBuffer 是异步的，等待其链收敛
    await new Promise(r => setTimeout(r, 0))

    expect(mockWriter.write).toHaveBeenCalled()
    expect(mockWriter.close).toHaveBeenCalled()
  })
})
