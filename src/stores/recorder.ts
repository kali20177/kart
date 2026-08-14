import { defineStore } from 'pinia'
import { shallowRef, triggerRef, watch, computed, onScopeDispose } from 'vue'
import type { Ref } from 'vue'
import type { RecordConfig, RecordFormat, RecordState } from '@/types'
import { useSerialStore } from './serial'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from './settings'
import { useRecordDirectory } from '@/composables/useRecordDirectory'
import type { IFileWriter } from '@/composables/useFileWriter'
import { logger } from '@/utils/logger'

/** recorder store 的外部依赖——原始字节流与连接状态来自 serial，录制格式来自全局设置。 */
export interface RecorderDeps {
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  onTxData: (cb: (bytes: Uint8Array) => void) => () => void
  connected: Ref<boolean>
  /** 当前端口（文件名标识数据来源 + 主进程流键控区分会话）。null 表示未选端口。 */
  port: Ref<string | null>
  settings: { recordFormat: RecordFormat }
}

const FLUSH_INTERVAL_MS = 500
const FLUSH_SIZE_BYTES = 64 * 1024
// 缓冲区上限（字节）。写盘慢于到达速率时防止内存无界增长——
// 超过则丢弃最旧批次并通过状态向用户示警。
const BUFFER_HARD_LIMIT_BYTES = 16 * 1024 * 1024

export function createRecorderStore(deps: RecorderDeps) {
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
  // 正在执行的 flush Promise——stop/wait 须 await 它，否则 stop 关闭流后
  // 在途 flush 对已关闭流写入会抛错并把状态翻成 error。
  let pendingFlush: Promise<void> = Promise.resolve()
  // 是否正在停止。置位后 flushBuffer 不再走 error 分支改写状态。
  let stopping = false
  // Electron 流级错误的异步回调注销函数
  let unsubWriteError: (() => void) | null = null

  function patchState(patch: Partial<RecordState>) {
    state.value = { ...state.value, ...patch }
    triggerRef(state)
  }

  /**
   * 端口名 → 文件系统安全片段。POSIX 禁 `/`，Windows 禁 `\ : * ? " < > |`，
   * macOS(HFS+) 对 `:` 敏感——统一替换为 `-` 并裁剪首尾。
   * 如 /dev/cu.usbserial-2430 → dev-cu.usbserial-2430。
   */
  function sanitizePortName(port: string): string {
    const cleaned = port.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
    return cleaned || 'no-port'
  }

  /** 录制流键：多会话并排录制时主进程按 (窗口, 端口) 区分写入流，避免互相覆盖 */
  function streamKey(): string {
    return deps.port.value ? sanitizePortName(deps.port.value) : 'no-port'
  }

  function generateFileName(format: RecordFormat): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const ext = format === 'csv' ? 'csv' : 'txt'
    // 文件名带端口标识：并排多会话录制时用户能分清数据来源
    return `serial-log-${streamKey()}-${stamp}.${ext}`
  }

  async function start(_config?: RecordConfig) {
    if (state.value.status !== 'idle') return

    if (!recordDir.isConfigured.value) {
      throw new Error('请先在设置中配置录制目录')
    }

    const format = _config?.format ?? deps.settings.recordFormat
    const fileName = generateFileName(format)
    const w = await recordDir.createFile(fileName, streamKey())
    if (!w) {
      throw new Error('无法在录制目录中创建文件')
    }

    writer = w
    buffer = []
    bufferSize = 0
    stopping = false
    // 仅在 idle 时可达（stop/pagehide 已 await 收敛旧链），重置为已解决即可
    pendingFlush = Promise.resolve()

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
      byteCount: 0,
      error: undefined
    })

    logger.info('recorder', `recording started: ${w.getFileName()} format=${format}`)

    unsubRx = deps.onData((bytes) => ingest(bytes, 'rx', format))
    unsubTx = deps.onTxData((bytes) => ingest(bytes, 'tx', format))

    // 监听 Electron 流级异步错误（两次 write 之间的 ENOSPC 等），
    // 立即将状态翻为 error 而非等下次 write-chunk 才检测到。
    if (window.electron?.recorder?.onWriteError) {
      window.electron.recorder.onWriteError((msg) => {
        if (!stopping && state.value.status === 'recording') {
          logger.error('recorder', `stream write error: ${msg}`)
          patchState({ status: 'error', error: `写盘错误: ${msg}` })
        }
      })
      unsubWriteError = () => {
        window.electron?.recorder?.onWriteError(() => {})
      }
    }

    flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS)
  }

  async function stop() {
    if (state.value.status !== 'recording' && state.value.status !== 'error') return

    stopping = true
    patchState({ status: 'stopping' })

    unsubRx?.()
    unsubRx = null
    unsubTx?.()
    unsubTx = null
    unsubWriteError?.()
    unsubWriteError = null

    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }

    // 等待在途 flush 完成，避免它对已关闭流写入抛错并翻状态为 error。
    await pendingFlush
    await flushBuffer(writer)
    await writer?.close()
    writer = null

    logger.info('recorder', `recording stopped: ${state.value.fileName} ${state.value.fileSize}B ${state.value.byteCount}B`)

    stopping = false
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

    // 背压：写盘慢于到达速率时，丢弃最旧批次并将状态标为 error，
    // 避免缓冲区无界增长吃光内存。
    if (bufferSize > BUFFER_HARD_LIMIT_BYTES) {
      const dropped = buffer.shift()
      if (dropped) bufferSize -= dropped.length
      logger.error('recorder', `buffer overflow (>${BUFFER_HARD_LIMIT_BYTES}B), write too slow`)
      patchState({
        status: 'error',
        error: '写入跟不上数据速率，录制已停止，请降低波特率或检查磁盘'
      })
      return
    }

    if (bufferSize >= FLUSH_SIZE_BYTES) {
      flushBuffer()
    }
  }

  async function flushBuffer(w: IFileWriter | null = writer): Promise<void> {
    if (buffer.length === 0 || !w) return

    const chunks = buffer
    const total = bufferSize
    buffer = []
    bufferSize = 0

    // 立即启动写入（保持「ingest 同步触发 flush」的时序语义）；
    // 返回的 pendingFlush 供 stop/pagehide await 本次写完成。
    pendingFlush = (async () => {
      try {
        for (const chunk of chunks) {
          await w.write(chunk)
        }
        patchState({ fileSize: state.value.fileSize + total })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 停止流程中发生的错误不翻成 error，避免冲掉正在收敛的 idle 态
        if (!stopping) {
          logger.error('recorder', `flush failed: ${msg}`)
          patchState({ status: 'error', error: `写入失败: ${msg}` })
        }
      }
    })()
    return pendingFlush
  }

  // 断线自动停止
  watch(deps.connected, (connected) => {
    if (!connected && (state.value.status === 'recording' || state.value.status === 'error')) {
      stop()
    }
  })

  // 页面/窗口关闭时尽力落盘剩余数据，否则缓冲区内存数据随销毁丢失。
  // pagehide 在 bfcache 与正常卸载都会触发；Electron 同样适用。
  function handlePageHide() {
    // 同步清理订阅与定时器，避免泄露；
    // 尽力 flush + close——async 写入可能在页面销毁前未完成，但聊胜于无。
    unsubRx?.()
    unsubTx?.()
    unsubTx = null
    unsubRx = null
    unsubWriteError?.()
    unsubWriteError = null
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    // 捕获局部 writer 引用再置空：flushBuffer 内部已不再读模块级 writer，
    // 拿到的引用闭包捕获后在置空后仍有效，close 一定能执行到。
    const w = writer
    writer = null
    void flushBuffer(w).then(() => w?.close())
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handlePageHide, { capture: true })
  }

  // 会话销毁清理：移除 pagehide 监听 + 复用 handlePageHide 的订阅/定时器/文件句柄清理。
  // handlePageHide 幂等（?. 空安全），重复调用安全。
  onScopeDispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', handlePageHide, { capture: true })
    }
    handlePageHide()
  })

  return {
    state,
    isRecording,
    canRecord,
    supported,
    start,
    stop
  }
}

/** 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。 */
export const useRecorderStore = defineStore('recorder', () => {
  const serial = useSerialStore()
  const settings = useSettingsStore()
  return createRecorderStore({
    onData: (cb) => serial.onData(cb),
    onTxData: (cb) => serial.onTxData(cb),
    connected: storeToRefs(serial).connected,
    port: storeToRefs(serial).selectedPort,
    settings: settings.settings,
  })
})
