import { defineStore } from 'pinia'
import { shallowRef, triggerRef, watch, computed } from 'vue'
import type { RecordConfig, RecordFormat, RecordState } from '@/types'
import { useSerialStore } from './serial'
import { useSettingsStore } from './settings'
import { useRecordDirectory } from '@/composables/useRecordDirectory'
import type { IFileWriter } from '@/composables/useFileWriter'

const FLUSH_INTERVAL_MS = 500
const FLUSH_SIZE_BYTES = 64 * 1024

export const useRecorderStore = defineStore('recorder', () => {
  const serial = useSerialStore()
  const settings = useSettingsStore()
  const recordDir = useRecordDirectory()

  const state = shallowRef<RecordState>({
    status: 'idle',
    fileName: '',
    fileSize: 0,
    startedAt: 0,
    byteCount: 0
  })

  const isRecording = computed(() => state.value.status === 'recording')

  /** 是否可以录制（有格式配置且有保存目录） */
  const canRecord = computed(() => recordDir.isConfigured.value)

  /** 平台是否支持录制功能 */
  const supported = computed(() => {
    if (typeof window === 'undefined') return false
    if (window.electron?.recorder) return true
    if ('showDirectoryPicker' in window) return true
    return false
  })

  let writer: IFileWriter | null = null
  let buffer: Uint8Array[] = []
  let bufferSize = 0
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let unsubRx: (() => void) | null = null
  let unsubTx: (() => void) | null = null

  function patchState(patch: Partial<RecordState>) {
    state.value = { ...state.value, ...patch }
    triggerRef(state)
  }

  function generateFileName(format: RecordFormat): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const ext = format === 'csv' ? 'csv' : 'txt'
    return `serial-log-${stamp}.${ext}`
  }

  async function start(_config?: RecordConfig) {
    if (state.value.status !== 'idle') return

    if (!recordDir.isConfigured.value) {
      throw new Error('请先在设置中配置录制目录')
    }

    const format = _config?.format ?? settings.settings.recordFormat
    const fileName = generateFileName(format)
    const w = await recordDir.createFile(fileName)
    if (!w) {
      throw new Error('无法在录制目录中创建文件')
    }

    writer = w
    buffer = []
    bufferSize = 0

    // CSV 格式写入表头
    if (format === 'csv') {
      const header = new TextEncoder().encode('timestamp,direction,hex,ascii\n')
      buffer.push(header)
      bufferSize += header.length
    }

    patchState({
      status: 'recording',
      fileName: w.getFileName(),
      fileSize: 0,
      startedAt: Date.now(),
      byteCount: 0
    })

    unsubRx = serial.onData((bytes) => ingest(bytes, 'rx', format))
    unsubTx = serial.onTxData((bytes) => ingest(bytes, 'tx', format))

    flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS)
  }

  async function stop() {
    if (state.value.status !== 'recording' && state.value.status !== 'error') return

    patchState({ status: 'stopping' })

    unsubRx?.()
    unsubRx = null
    unsubTx?.()
    unsubTx = null

    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }

    await flushBuffer()
    await writer?.close()
    writer = null

    patchState({ status: 'idle' })
  }

  function bytesToAscii(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) {
      s += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.'
    }
    return s
  }

  function csvEscape(field: string): string {
    if (/[",\r\n]/.test(field)) {
      return `"${field.replace(/"/g, '""')}"`
    }
    return field
  }

  function ingest(bytes: Uint8Array, direction: 'rx' | 'tx', format: RecordFormat) {
    if (state.value.status !== 'recording') return

    let copy: Uint8Array
    if (format === 'text') {
      const ts = new Date().toISOString()
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
      const dir = direction === 'rx' ? 'RX' : 'TX'
      const line = `[${ts}] ${dir} ${hex}\n`
      copy = new TextEncoder().encode(line)
    } else {
      // csv
      const ts = new Date().toISOString()
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
      const ascii = csvEscape(bytesToAscii(bytes))
      const line = `${ts},${direction},${hex},${ascii}\n`
      copy = new TextEncoder().encode(line)
    }
    buffer.push(copy)
    bufferSize += copy.length

    patchState({ byteCount: state.value.byteCount + bytes.length })

    if (bufferSize >= FLUSH_SIZE_BYTES) {
      flushBuffer()
    }
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0 || !writer) return

    const chunks = buffer
    const total = bufferSize
    buffer = []
    bufferSize = 0

    try {
      for (const chunk of chunks) {
        await writer.write(chunk)
      }
      patchState({ fileSize: state.value.fileSize + total })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      patchState({ status: 'error', error: `写入失败: ${msg}` })
    }
  }

  // 断线自动停止
  watch(() => serial.connected, (connected) => {
    if (!connected && state.value.status === 'recording') {
      stop()
    }
  })

  return {
    state,
    isRecording,
    canRecord,
    supported,
    start,
    stop
  }
})
