import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef, computed, watch } from 'vue'
import type { FileTransferConfig, FileTransferState, TransferPresetId, TransferStatus } from '@/types'
import { useSerialStore } from './serial'
import { useMessagesStore } from './messages'

/** 预设配置 */
const PRESETS: Record<TransferPresetId, Partial<FileTransferConfig>> = {
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

export const useTransferStore = defineStore('transfer', () => {
  const serial = useSerialStore()
  const messages = useMessagesStore()

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
  let unsubAck: (() => void) | null = null
  // 字节数组缓存（pump 循环读取）
  let fileBytes: Uint8Array | null = null
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

  // ── 限速工具 ──

  function paceDelay(
    _now: number,
    startedAt: number,
    sent: number,
    bps: number,
    interDelay: number
  ): number {
    if (!bps) return interDelay
    const elapsed = _now - startedAt
    const target = (bps * elapsed) / 1000
    const deficit = sent - target
    return Math.max(interDelay, deficit > 0 ? (deficit / bps) * 1000 : 0)
  }

  // ── CRC16-Modbus 工具 ──

  function crc16(data: Uint8Array): number {
    let crc = 0xffff
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i]
      for (let j = 0; j < 8; j++) {
        if (crc & 1) {
          crc = (crc >> 1) ^ 0xa001
        } else {
          crc >>= 1
        }
      }
    }
    return crc
  }

  // ── 帧封装 ──

  function frameChunk(chunk: Uint8Array, seq: number, config: FileTransferConfig): Uint8Array {
    const { framing, chunkSuffix } = config
    let wire: Uint8Array

    switch (framing) {
      case 'len-prefix': {
        const len = chunk.length
        const header = new Uint8Array([len & 0xff, (len >> 8) & 0xff])
        wire = new Uint8Array(header.length + chunk.length)
        wire.set(header)
        wire.set(chunk, header.length)
        break
      }
      case 'seq-crc': {
        const len = chunk.length
        const crcVal = crc16(chunk)
        const header = new Uint8Array([
          seq & 0xff, (seq >> 8) & 0xff,
          len & 0xff, (len >> 8) & 0xff
        ])
        const footer = new Uint8Array([crcVal & 0xff, (crcVal >> 8) & 0xff])
        wire = new Uint8Array(header.length + chunk.length + footer.length)
        wire.set(header)
        wire.set(chunk, header.length)
        wire.set(footer, header.length + chunk.length)
        break
      }
      default: // raw
        wire = new Uint8Array(chunk)
        break
    }

    // 追加行尾
    if (chunkSuffix !== 'none') {
      const suffixMap: Record<string, Uint8Array> = {
        cr: new Uint8Array([0x0d]),
        lf: new Uint8Array([0x0a]),
        crlf: new Uint8Array([0x0d, 0x0a])
      }
      const suffix = suffixMap[chunkSuffix] || new Uint8Array(0)
      if (suffix.length > 0) {
        const combined = new Uint8Array(wire.length + suffix.length)
        combined.set(wire)
        combined.set(suffix, wire.length)
        wire = combined
      }
    }

    return wire
  }

  // ── 错误注入 ──

  function maybeInjectError(wire: Uint8Array, chunkSeq: number, config: FileTransferConfig): Uint8Array {
    if (config.injectCorruptEveryN > 0 && chunkSeq > 0 && chunkSeq % config.injectCorruptEveryN === 0) {
      // 把最后一个字节翻转
      const corrupted = new Uint8Array(wire)
      corrupted[corrupted.length - 1] ^= 0xff
      return corrupted
    }
    return wire
  }

  // ── ACK 订阅 ──

  function subscribeAck(): void {
    if (unsubAck) return
    unsubAck = serial.onData((_bytes: Uint8Array) => {
      // ACK 匹配逻辑在 sendWithRetry 中同步等待，此处仅接收
      // 真正的匹配在 sendWithRetry 内通过 serial.onData 的回调队列完成
    })
  }

  function unsubscribeAck(): void {
    unsubAck?.()
    unsubAck = null
  }

  // ── 发送并等待 ACK ──

  async function sendWithRetry(
    wire: Uint8Array,
    config: FileTransferConfig
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (abortFlag) return false

      const r = await serial.sendRaw(wire, config.logEachChunk)
      if (!r.ok) {
        if (attempt < config.retries) continue
        return false
      }

      if (!config.waitForAck) return true

      // 等待 ACK
      const ackOk = await waitForAck(config)
      if (ackOk) return true
      if (abortFlag) return false
      // 超时或 NACK，重试
    }
    return false
  }

  function waitForAck(config: FileTransferConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        unsub?.()
        resolve(false)
      }, config.ackTimeout)

      const unsub = serial.onData((bytes: Uint8Array) => {
        for (const b of bytes) {
          if (config.ackMode === 'any') {
            clearTimeout(timeout)
            unsub()
            resolve(true)
            return
          }
          if (config.ackMode === 'byte') {
            if (b === config.ackByte) {
              clearTimeout(timeout)
              unsub()
              resolve(true)
              return
            }
            // NACK (0x15) — 立即失败重试
            if (b === 0x15) {
              clearTimeout(timeout)
              unsub()
              resolve(false)
              return
            }
          }
          // echo-crc: 需要对比 CRC，暂简化为收到任意字节即 ACK
          if (config.ackMode === 'echo-crc') {
            clearTimeout(timeout)
            unsub()
            resolve(true)
            return
          }
        }
      })
    })
  }

  // ── pump 循环 ──

  let pumpRunning = false

  async function pump(filename: string, bytes: Uint8Array, config: FileTransferConfig) {
    if (pumpRunning) return
    pumpRunning = true
    abortFlag = false
    pauseGate = null
    pausePromise = null

    const id = addTransfer(filename, bytes.length, config)
    activeId.value = id
    const state = transfers.value.find((t) => t.id === id)!
    state.status = 'sending'
    triggerRef(transfers)

    // 添加消息气泡
    messages.addFileTransfer(id, filename, bytes.length)

    // 订阅 ACK
    if (config.waitForAck) subscribeAck()

    const startTime = Date.now()
    let totalSent = 0
    let seq = Math.floor(config.startOffset / (config.chunkSize || 1))
    let chunkIndex = Math.floor(config.startOffset / (config.chunkSize || 1))
    let pass = 1
    let lastUpdateTime = startTime
    let lastSent = 0

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

      while (chunkIndex < Math.ceil(bytes.length / (config.chunkSize || bytes.length))) {
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

        // 取切片
        const chunkSize = config.chunkSize > 0 ? config.chunkSize : bytes.length
        const start = chunkIndex * chunkSize
        const end = Math.min(start + chunkSize, bytes.length)
        const chunk = bytes.slice(start, end)

        // 封装
        let wire = frameChunk(chunk, seq, config)
        // 错误注入
        wire = maybeInjectError(wire, chunkIndex, config)

        // 发送
        const ok = await sendWithRetry(wire, config)
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

    // 完成
    cleanupPump(id, 'completed')
  }

  function cleanupPump(id: string, status: TransferStatus, failedChunk?: number) {
    pumpRunning = false
    unsubscribeAck()
    fileBytes = null
    filePath = ''

    const patch: Partial<FileTransferState> = {
      status,
      elapsedMs: Date.now() - (transfers.value.find((t) => t.id === id)?.startedAt ?? Date.now())
    }
    if (failedChunk !== undefined) patch.failedChunk = failedChunk
    if (status === 'error') patch.error = '发送失败（重试耗尽）'
    updateTransfer(id, patch)

    if (activeId.value === id) activeId.value = null
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ── 公开操作 ──

  /** 读取文件并开始下发 */
  async function start(file: File, config: FileTransferConfig) {
    if (activeId.value) {
      await abort(activeId.value)
    }
    if (!serial.connected) return

    const bytes = new Uint8Array(await file.arrayBuffer())
    fileBytes = bytes
    filePath = file.name
    fileConfig = { ...config }

    // 保存最后配置
    lastConfig.value = { ...config }

    pump(file.name, bytes, config)
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
    if (!serial.connected) return

    // 从历史中移除旧记录
    const list = transfers.value.filter((x) => x.id !== id)
    transfers.value = list
    triggerRef(transfers)

    // 读取文件重新开始
    // 注意：重试需要文件还在，如果文件不在内存中则无法重试
    // 这里简化处理：如果有 fileBytes 且文件名匹配，直接重发
    if (fileBytes && filePath === t.filename) {
      pump(t.filename, fileBytes, fileConfig)
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
  watch(
    () => serial.connected,
    (c) => {
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
        unsubscribeAck()
      }
    }
  )

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
})