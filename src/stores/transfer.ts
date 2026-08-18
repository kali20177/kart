import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef, computed, watch, onScopeDispose } from 'vue'
import type { Ref } from 'vue'
import type { FileTransferConfig, FileTransferState, TransferPresetId, TransferStatus } from '@/types'
import { useSerialStore } from './serial'
import { storeToRefs } from 'pinia'
import { useMessagesStore } from './messages'
import { crc16modbus } from '@/utils/checksum'
import { frameChunk, injectCorrupt } from '@/utils/chunk-framer'
import { paceDelay } from '@/utils/rate-limit'
import { matchEchoCrc, isNackByte } from '@/utils/ack'
import { fileSource } from '@/utils/chunk-source'
import type { ChunkSource } from '@/utils/chunk-source'
import { logger } from '@/utils/logger'

/** transfer store 的外部依赖——下发/ACK 数据与连接状态来自 serial，文件气泡入消息列表。 */
export interface TransferDeps {
  sendRaw: (bytes: Uint8Array, record?: boolean) => Promise<{ ok: boolean; error?: string }>
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  connected: Ref<boolean>
  addFileTransfer: (transferId: string, filename: string, size: number) => void
}

/** 预设配置（也供 FileTransferDialog 复用） */
export const PRESETS: Record<TransferPresetId, Partial<FileTransferConfig>> = {
  raw: {
    chunkSize: 0,
    interChunkDelay: 0,
    bytesPerSecond: 0,
    retries: 0,
    framing: 'raw',
    chunkSuffix: 'none',
    waitForAck: false,
    ackMode: 'any',
    ackByte: 0x06,
    ackTimeout: 1000,
    startOffset: 0,
    repeat: 0,
    logEachChunk: false,
    injectCorruptEveryN: 0,
    injectSkipAckEveryN: 0
  },
  'stm32-isp': {
    chunkSize: 256,
    interChunkDelay: 10,
    bytesPerSecond: 0,
    retries: 3,
    framing: 'seq-crc',
    chunkSuffix: 'none',
    waitForAck: true,
    ackMode: 'byte',
    ackByte: 0x06,
    ackTimeout: 2000,
    startOffset: 0,
    repeat: 0,
    logEachChunk: false,
    injectCorruptEveryN: 0,
    injectSkipAckEveryN: 0
  },
  esp32: {
    chunkSize: 4096,
    interChunkDelay: 5,
    bytesPerSecond: 0,
    retries: 2,
    framing: 'len-prefix',
    chunkSuffix: 'none',
    waitForAck: true,
    ackMode: 'any',
    ackByte: 0x06,
    ackTimeout: 3000,
    startOffset: 0,
    repeat: 0,
    logEachChunk: false,
    injectCorruptEveryN: 0,
    injectSkipAckEveryN: 0
  },
  stress: {
    chunkSize: 512,
    interChunkDelay: 20,
    bytesPerSecond: 0,
    retries: 3,
    framing: 'raw',
    chunkSuffix: 'none',
    waitForAck: false,
    ackMode: 'any',
    ackByte: 0x06,
    ackTimeout: 1000,
    startOffset: 0,
    repeat: 10,
    logEachChunk: false,
    injectCorruptEveryN: 0,
    injectSkipAckEveryN: 0
  },
  custom: {}
}

/** 默认配置（与 raw 预设相同） */
const DEFAULT_CONFIG: FileTransferConfig = { ...PRESETS.raw } as FileTransferConfig

let nextTransferId = 1
function genId(): string {
  return `ft-${nextTransferId++}-${Date.now().toString(36)}`
}

export function createTransferStore(deps: TransferDeps) {
  // 所有下发的历史 + 活跃列表（浅响应，手动 triggerRef 刷新）
  const transfers = shallowRef<FileTransferState[]>([])
  // 活跃下发 ID（同时只能有一个活跃）
  const activeId = ref<string | null>(null)

  /** 上一次配置（持久化在内存，下次打开自动回填） */
  const lastConfig = ref<FileTransferConfig>({ ...DEFAULT_CONFIG })
  const lastPreset = ref<TransferPresetId>('raw')

  // ── 引擎内部状态 ──
  // 这些不暴露给 UI，仅在 pump 循环中使用
  let abortFlag = false
  let pauseGate: (() => void) | null = null   // resolve 函数
  let pausePromise: Promise<void> | null = null
  // 最近一次下发的 File 句柄（重试/续传重读用；流式读不驻留字节，仅句柄）
  let fileData: File | null = null
  let filePath = ''
  let fileConfig: FileTransferConfig = { ...DEFAULT_CONFIG }

  // ── 计算属性 ──

  /** 活跃下发状态（用于气泡实时更新） */
  const activeTransfer = computed<FileTransferState | null>(() => {
    if (!activeId.value) return null
    return transfers.value.find((t) => t.id === activeId.value) ?? null
  })

  /** 是否有活跃下发 */
  const hasActive = computed(() => activeId.value !== null)

  /** 活跃下发是否正在发送中 */
  const isSending = computed(() => activeTransfer.value?.status === 'sending')

  // ── 工具函数 ──

  function updateTransfer(id: string, patch: Partial<FileTransferState>) {
    const list = [...transfers.value]
    const idx = list.findIndex((t) => t.id === id)
    if (idx === -1) return
    list[idx] = { ...list[idx], ...patch }
    transfers.value = list
    triggerRef(transfers)
  }

  function addTransfer(filename: string, size: number, config: FileTransferConfig): string {
    const id = genId()
    const totalChunks = config.chunkSize > 0 ? Math.ceil(size / config.chunkSize) : 1
    const entry: FileTransferState = {
      id,
      filename,
      size,
      status: 'queued',
      sent: 0,
      total: size,
      currentChunk: 0,
      totalChunks,
      pass: 1,
      startedAt: Date.now(),
      elapsedMs: 0,
      bytesPerSec: 0
    }
    transfers.value = [...transfers.value, entry]
    triggerRef(transfers)
    // 保留最近 20 条
    if (transfers.value.length > 20) {
      transfers.value = transfers.value.slice(transfers.value.length - 20)
      triggerRef(transfers)
    }
    return id
  }

  // ── 发送并等待 ACK ──

  async function sendWithRetry(
    wire: Uint8Array,
    chunkIndex: number,
    config: FileTransferConfig,
    expectedCrc: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (abortFlag) return false

      let r: { ok: boolean; error?: string }
      try {
        r = await deps.sendRaw(wire, config.logEachChunk)
      } catch (err) {
        // 驱动写抛错（串口断开/IO 故障等）：按重试次数处理，避免未捕获拒绝卡死 pump
        logger.warn('transfer', `sendRaw 异常（attempt ${attempt + 1}）: ${(err as Error)?.message ?? String(err)}`)
        if (attempt < config.retries) continue
        return false
      }
      if (!r.ok) {
        if (attempt < config.retries) continue
        return false
      }

      if (!config.waitForAck) return true

      // 错误注入：跳过 ACK（模拟丢包触发超时→重试）
      if (
        config.injectSkipAckEveryN > 0 &&
        chunkIndex > 0 &&
        chunkIndex % config.injectSkipAckEveryN === 0
      ) {
        if (attempt < config.retries) continue
        return false
      }

      // 等待 ACK（echo-crc 需要本包期望 CRC 做回吐比对）
      const ackOk = await waitForAck(config, expectedCrc)
      if (ackOk) return true
      if (abortFlag) return false
      // 超时或 NACK，重试
    }
    return false
  }

  function waitForAck(config: FileTransferConfig, expectedCrc: number): Promise<boolean> {
    return new Promise((resolve) => {
      // echo-crc 需要累积回吐字节（≥2 字节后按小端比对）；其余模式逐字节立即判定
      const echoBuf: number[] = []
      let finished = false
      let unsub: (() => void) | null = null
      let nackTimer: ReturnType<typeof setTimeout> | undefined
      // NACK 宽限窗口：echo-crc 首字节 0x15 可能是独立 NACK，也可能是 CRC 低字节。
      // 等第二字节最多 min(ackTimeout/2, 50)ms——到达则按 echo 比对，不到则判 NACK，
      // 消除「CRC 字节恰为 0x15 → 每次重试都确定性误判 NACK」的线缆歧义。
      const nackGrace = Math.min(config.ackTimeout / 2, 50)

      // 幂等收尾：超时与响应竞态时只 resolve 一次
      const finish = (ok: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        if (nackTimer !== undefined) clearTimeout(nackTimer)
        unsub?.()
        resolve(ok)
      }

      const timeout = setTimeout(() => finish(false), config.ackTimeout)

      unsub = deps.onData((bytes: Uint8Array) => {
        for (const b of bytes) {
          if (config.ackMode === 'any') {
            finish(true)
            return
          }
          if (config.ackMode === 'byte') {
            if (b === config.ackByte) {
              finish(true)
              return
            }
            // NACK (0x15) — 立即失败重试
            if (isNackByte(b)) {
              finish(false)
              return
            }
          }
          if (config.ackMode === 'echo-crc') {
            if (echoBuf.length === 0 && isNackByte(b)) {
              nackTimer = setTimeout(() => finish(false), nackGrace)
            }
            echoBuf.push(b)
            if (echoBuf.length >= 2) {
              if (nackTimer !== undefined) {
                clearTimeout(nackTimer)
                nackTimer = undefined
              }
              finish(matchEchoCrc(echoBuf, expectedCrc))
              return
            }
          }
        }
      })

      // 若驱动在订阅时同步回调（异常注入场景），finish 已跑但 unsub 尚未赋值，
      // 这里补一次解除，避免订阅泄漏
      if (finished) unsub?.()
    })
  }

  // ── pump 循环 ──

  let pumpRunning = false

  async function pump(filename: string, source: ChunkSource, config: FileTransferConfig) {
    if (pumpRunning) return
    pumpRunning = true
    abortFlag = false
    pauseGate = null
    pausePromise = null

    const id = addTransfer(filename, source.size, config)
    activeId.value = id
    const state = transfers.value.find((t) => t.id === id)!
    state.status = 'sending'
    triggerRef(transfers)

    // 添加消息气泡
    deps.addFileTransfer(id, filename, source.size)

    const startTime = Date.now()
    let totalSent = 0
    let seq = Math.floor(config.startOffset / (config.chunkSize || 1))
    let chunkIndex = Math.floor(config.startOffset / (config.chunkSize || 1))
    let pass = 1
    let lastUpdateTime = startTime
    let lastSent = 0

    try {
      while (pass <= (config.repeat > 0 ? config.repeat : 1)) {
        // 如果 repeat > 0，每一轮重置
        if (config.repeat > 0 && pass > 1) {
          totalSent = 0
          chunkIndex = 0
          seq = 0
          updateTransfer(id, {
            sent: 0,
            currentChunk: 0,
            pass,
            status: 'sending'
          })
        }

        while (chunkIndex < Math.ceil(source.size / (config.chunkSize || source.size))) {
          // 检查暂停
          if (pausePromise) {
            await pausePromise
            pausePromise = null
            pauseGate = null
          }
          if (abortFlag) {
            cleanupPump(id, 'aborted')
            return
          }

          // 取切片（数据源按 [start,end) 增量读取，内存占用有界为 chunkSize）
          const chunkSize = config.chunkSize > 0 ? config.chunkSize : source.size
          const start = chunkIndex * chunkSize
          const end = Math.min(start + chunkSize, source.size)
          const chunk = await source.slice(start, end)

          // 封装
          let wire = frameChunk(chunk, seq, config.framing, config.chunkSuffix)
          // 错误注入
          wire = injectCorrupt(wire, chunkIndex, config.injectCorruptEveryN)

          // echo-crc 需要本包期望 CRC（设备回吐的比对基准；payload 的 CRC16）
          const expectedCrc = config.ackMode === 'echo-crc' ? crc16modbus(chunk) : 0

          // 发送
          const ok = await sendWithRetry(wire, chunkIndex, config, expectedCrc)
          if (!ok) {
            cleanupPump(id, 'error', chunkIndex)
            return
          }

          totalSent += chunk.length
          chunkIndex++
          seq++

          // 限速
          const now = Date.now()
          const delay = paceDelay(now, startTime, totalSent, config.bytesPerSecond, config.interChunkDelay)
          if (delay > 0) {
            const waitStart = Date.now()
            while (Date.now() - waitStart < delay) {
              if (abortFlag) {
                cleanupPump(id, 'aborted')
                return
              }
              await sleep(10)
            }
          }

          // 更新进度（rAF 风格批处理）
          const updateTime = Date.now()
          const dt = updateTime - lastUpdateTime
          if (dt >= 50) {
            const deltaSent = totalSent - lastSent
            const instantRate = dt > 0 ? (deltaSent / dt) * 1000 : 0
            // 首次直接用瞬时值，后续用 EMA 平滑（alpha=0.5 收敛更快）
            // 注意：不能从 line 358 捕获的 state 引用读取 bytesPerSec——
            // updateTransfer 会创建新对象替换 shallowRef 数组，原引用已过期。
            const current = transfers.value.find((t) => t.id === id)
            const prevRate = current?.bytesPerSec ?? 0
            const bytesPerSec = prevRate === 0
              ? instantRate
              : prevRate * 0.5 + instantRate * 0.5

            updateTransfer(id, {
              sent: totalSent,
              currentChunk: chunkIndex,
              elapsedMs: updateTime - startTime,
              bytesPerSec: Math.round(bytesPerSec)
            })
            lastUpdateTime = updateTime
            lastSent = totalSent
          }
        }

        pass++
      }
    } catch (err) {
      // 兜底：读片/发送/订阅等任何未捕获异常都收敛为 error 并释放引擎，
      // 避免 pumpRunning 永久卡 true（后续下发被 if (pumpRunning) return 静默拒绝）
      logger.error('transfer', `pump 异常中断: ${(err as Error)?.message ?? String(err)}`)
      cleanupPump(id, 'error', chunkIndex, `发送中断：${(err as Error)?.message ?? String(err)}`)
      return
    }

    // 完成
    cleanupPump(id, 'completed')
  }

  function cleanupPump(id: string, status: TransferStatus, failedChunk?: number, errorMsg?: string) {
    pumpRunning = false
    // 保留 fileData/filePath 供 retry 重新读文件（File 可多次随机切片读，无内存驻留）

    const rec = transfers.value.find((t) => t.id === id)
    const tag = rec ? `${rec.filename} (${rec.sent}/${rec.total}B)` : id

    const patch: Partial<FileTransferState> = {
      status,
      elapsedMs: Date.now() - (rec?.startedAt ?? Date.now())
    }
    if (failedChunk !== undefined) patch.failedChunk = failedChunk
    if (status === 'error') patch.error = errorMsg ?? '发送失败（重试耗尽）'
    updateTransfer(id, patch)

    if (status === 'completed') logger.info('transfer', `completed: ${tag} in ${patch.elapsedMs}ms`)
    else if (status === 'error') logger.error('transfer', `failed: ${tag} at chunk ${failedChunk ?? '?'} (retries exhausted)`)
    else logger.info('transfer', `aborted: ${tag}`)

    if (activeId.value === id) activeId.value = null
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ── 公开操作 ──

  /** 记录文件句柄并开始下发（不读入内存——pump 按块 file.slice 增量读） */
  async function start(file: File, config: FileTransferConfig) {
    if (activeId.value) {
      await abort(activeId.value)
    }
    if (!deps.connected.value) return

    fileData = file
    filePath = file.name
    fileConfig = { ...config }

    logger.info('transfer', `start: ${file.name} ${file.size}B chunk=${config.chunkSize || 'whole'} framing=${config.framing} ack=${config.waitForAck} repeat=${config.repeat || 1}`)

    // 保存最后配置
    lastConfig.value = { ...config }

    pump(file.name, fileSource(file), config)
  }

  /** 暂停 */
  function pause(id: string) {
    if (pauseGate) return // 已暂停
    pausePromise = new Promise((resolve) => {
      pauseGate = resolve
    })
    updateTransfer(id, { status: 'paused' })
  }

  /** 继续 */
  function resume(id: string) {
    if (pauseGate) {
      pauseGate()
      pauseGate = null
    }
    updateTransfer(id, { status: 'sending' })
  }

  /** 中止 */
  async function abort(id: string) {
    abortFlag = true
    if (pauseGate) {
      pauseGate()
      pauseGate = null
    }
    updateTransfer(id, { status: 'aborted' })
    // 等待 pump 退出
    while (pumpRunning) {
      await sleep(10)
    }
  }

  /** 重试（重新发送已完成的或失败的下发） */
  async function retry(id: string) {
    const t = transfers.value.find((t) => t.id === id)
    if (!t) return
    if (!deps.connected.value) return

    // 从历史中移除旧记录
    const list = transfers.value.filter((x) => x.id !== id)
    transfers.value = list
    triggerRef(transfers)

    // 重新从 File 句柄读起（File 可多次随机切片读；文件名需与最近一次下发一致）
    if (fileData && filePath === t.filename) {
      pump(t.filename, fileSource(fileData), fileConfig)
    }
  }

  /** 切换暂停/继续 */
  function togglePause(id: string) {
    const t = transfers.value.find((x) => x.id === id)
    if (!t) return
    if (t.status === 'paused') resume(id)
    else if (t.status === 'sending') pause(id)
  }

  /** 获取指定下发的状态 */
  function getTransfer(id: string): FileTransferState | undefined {
    return transfers.value.find((t) => t.id === id)
  }

  /** 从内存中移除（清除已完成的历史记录） */
  function removeTransfer(id: string) {
    transfers.value = transfers.value.filter((t) => t.id !== id)
    triggerRef(transfers)
  }

  // ── 断线自动中止 ──
  watch(deps.connected, (c) => {
      if (!c && activeId.value) {
        const id = activeId.value
        updateTransfer(id, { status: 'error', error: '连接断开' })
        activeId.value = null
        abortFlag = true
        if (pauseGate) {
          pauseGate()
          pauseGate = null
        }
        pumpRunning = false
      }
    }
  )

  // 会话销毁清理：置中止标志停止 pump 循环、释放暂停门，避免在途下发继续向已销毁会话写数据。
  onScopeDispose(() => {
    abortFlag = true
    if (pauseGate) {
      pauseGate()
      pauseGate = null
    }
  })

  return {
    transfers,
    activeId,
    activeTransfer,
    hasActive,
    isSending,
    lastConfig,
    lastPreset,
    start,
    pause,
    resume,
    abort,
    retry,
    togglePause,
    getTransfer,
    removeTransfer
  }
}

/** 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。 */
export const useTransferStore = defineStore('transfer', () => {
  const serial = useSerialStore()
  const m = useMessagesStore()
  return createTransferStore({
    sendRaw: (bytes, record) => serial.sendRaw(bytes, record),
    onData: (cb) => serial.onData(cb),
    connected: storeToRefs(serial).connected,
    addFileTransfer: (id, filename, size) => m.addFileTransfer(id, filename, size),
  })
})