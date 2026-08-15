import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef, watch, onScopeDispose } from 'vue'
import { storeToRefs } from 'pinia'
import type { Ref } from 'vue'
import type { ChecksumConfig, Direction, FrameConfig, Message } from '@/types'
import type { DecodeField, DecoderConfig } from '@/decoders/types'
import { DEFAULT_DECODER_CONFIG, getDecoder } from '@/decoders'
import { FrameSplitter } from '@/composables/useFrameSplitter'
import { useSettingsStore } from './settings'
import { usePauseStore } from './pause'
import { verifyChecksum, checksumByteLength } from '@/utils/checksum'
import { defaultChecksumConfig } from '@/session/checksum'

/** 帧解码成功后的广播负载：字段（含数值）喂给仪表盘等数值消费方 */
export interface DecodeBroadcast {
  decoderId: string
  fields: DecodeField[]
  /** 帧到达时间（与消息时间戳一致） */
  timestamp: number
}

/** messages store 的外部依赖——帧配置/缓冲上限来自全局设置，暂停状态与清空来自 pause。
 *  设置对象是全局 settings store 的同一 reactive proxy（窄化为本 store 实际读取的字段）。 */
export interface MessagesDeps {
  settings: {
    frame: FrameConfig
    bufferLimit: number
  }
  /** 会话级校验和配置（按端口持久化，生产经 session 注入；单例用默认配置）。
   *  直接持有 reactive 对象（与 settings 同例），逐帧读取最新值。 */
  checksum: ChecksumConfig
  /** 会话级帧解码配置（按端口持久化，生产经 session 注入；单例用默认关闭配置）。
   *  直接持有 reactive 对象（与 settings 同例），逐帧读取最新值。 */
  decoder: DecoderConfig
  paused: Ref<boolean>
  pauseStartTime: Ref<number>
  togglePause: () => void
}

export function createMessagesStore(deps: MessagesDeps) {
  // 应用级全局暂停（与波形视图共享）——见 pause store 说明。
  const { paused, pauseStartTime } = deps

  // 用 shallowRef + 手动 triggerRef，避免逐条 push 触发深度响应式开销
  const messages = shallowRef<Message[]>([])
  const rxFrames = ref(0)
  const txFrames = ref(0)
  const rxErrorFrames = ref(0)
  // 环形缓冲裁剪累计丢弃的帧数（超 bufferLimit 静默丢弃的最旧帧）
  const droppedFrames = ref(0)

  let nextId = 1
  const splitter = new FrameSplitter(deps.settings.frame)

  // 解码结果订阅者：帧解码成功（matched）后 fan-out 字段，供仪表盘等数值消费方订阅。
  // 与 serial.onData 同款 Set 订阅者模式；暂停时 ingestRx 提前 return，广播天然冻结。
  const decodeListeners = new Set<(info: DecodeBroadcast) => void>()
  function onDecode(cb: (info: DecodeBroadcast) => void): () => void {
    decodeListeners.add(cb)
    return () => decodeListeners.delete(cb)
  }

  // 待刷入的帧队列 + rAF 批处理句柄
  let pending: Message[] = []
  let rafHandle: number | null = null
  // gap-timeout 尾帧刷新定时器
  let gapTimer: ReturnType<typeof setTimeout> | null = null

  // 设置里帧策略变化时同步给切分器
  watch(
    () => deps.settings.frame,
    (cfg) => splitter.setConfig({ ...cfg }),
    { deep: true }
  )

  function makeMessage(direction: Direction, bytes: Uint8Array, error?: string, timestamp: number = Date.now()): Message {
    return { id: nextId++, direction, bytes, timestamp, error }
  }

  /** rAF 合并刷入：把 pending 一次性并入 messages，并执行环形缓冲裁剪 */
  function scheduleFlush() {
    if (rafHandle != null) return
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    rafHandle = raf(() => {
      rafHandle = null
      if (pending.length === 0) return
      const limit = deps.settings.bufferLimit
      let next = messages.value.concat(pending)
      pending = []
      if (next.length > limit) {
        droppedFrames.value += next.length - limit
        next = next.slice(next.length - limit)
      }
      messages.value = next
      triggerRef(messages)
    })
  }

  /** 接收原始字节：经帧切分后入队 */
  function ingestRx(bytes: Uint8Array) {
    if (paused.value) return
    // 字节到达时间：作为帧时间戳，使消息时间与波形 X 轴（同样取到达时间）对齐。
    // 注意 gap-timeout 策略下帧在 gapMs 后才关闭，但不能用关闭时刻作时间戳--
    // 否则消息时间会系统性偏晚一个 gapMs（与波形差 ~20ms）。
    const arrived = Date.now()
    const frames = splitter.push(bytes, arrived)
    for (const f of frames) {
      pending.push(makeRxMessage(f, arrived))
      rxFrames.value++
    }
    if (frames.length > 0) scheduleFlush()

    // gap-timeout：安排尾帧在静默 gapMs 后刷新
    const frameCfg = deps.settings.frame
    if (frameCfg.strategy === 'gap-timeout') {
      if (gapTimer) clearTimeout(gapTimer)
      gapTimer = setTimeout(() => {
        // 读最新设置：用户可能在 ingest 与 flush 之间改了配置（deps.settings 为 live proxy）
        const tail = splitter.flush()
        for (const f of tail) {
          // 时间戳用本批字节到达时间（arrived），而非定时器触发时刻
          pending.push(makeRxMessage(f, arrived))
          rxFrames.value++
        }
        if (tail.length > 0) scheduleFlush()
      }, frameCfg.gapMs)
    }
  }

  /**
   * 对单个 RX 帧做可选校验 + 可选帧解码，返回带标记/字段视图的消息。
   * 校验失败仅打标记（由气泡渲染本地化徽章），不写死中文到 error 字段。
   * 载荷帧 = 剔除帧尾分隔符后的部分（分隔符切分器会原样保留在帧里）；
   * 校验与解码共用同一载荷视角——解码器字段偏移按此计算，避免 \\r\\n 被当作载荷导致必败。
   */
  function makeRxMessage(f: Uint8Array, timestamp: number): Message {
    const msg = makeMessage('rx', f, undefined, timestamp)

    let payload = f
    const delim = splitter.getDelimiter()
    if (delim.length > 0 && f.length > delim.length) {
      let tailMatch = true
      for (let i = 0; i < delim.length; i++) {
        if (f[f.length - delim.length + i] !== delim[i]) { tailMatch = false; break }
      }
      if (tailMatch) payload = f.subarray(0, f.length - delim.length)
    }

    // 接收校验（作用于载荷）
    if (deps.checksum.rx !== 'none') {
      const len = checksumByteLength(deps.checksum.rx)
      if (payload.length > len) {
        const r = verifyChecksum(payload, deps.checksum.rx)
        if (!r.ok) {
          msg.checksumFailed = true
          rxErrorFrames.value++
        }
      }
    }

    // 帧解码：选了解码器（id 非空）且本帧匹配时叠加结构化字段视图；不匹配保持原始帧显示。
    // try/catch 兜底：解码器配置是可由用户手改的持久化 JSON，解码器契约上不应抛——
    // 一旦异常（如极端非法配置）静默丢弃本帧解码，绝不打穿 RX 管线。
    const dc = deps.decoder
    if (dc.id) {
      const def = getDecoder(dc.id)
      if (def) {
        try {
          const r = def.decode(payload, dc.options)
          if (r.matched) {
            msg.decoded = { decoderId: dc.id, summary: r.summary, fields: r.fields ?? [] }
            const fields = msg.decoded.fields
            if (fields.length > 0 && decodeListeners.size > 0) {
              for (const cb of decodeListeners) {
                try { cb({ decoderId: dc.id, fields, timestamp }) } catch { /* 忽略订阅者异常 */ }
              }
            }
          }
        } catch {
          /* 解码器异常：丢弃本帧解码，保持原始帧视图 */
        }
      }
    }
    return msg
  }

  /** 添加一条发送消息（TX 不切分，用户发什么就是一帧） */
  function addTx(bytes: Uint8Array, error?: string) {
    pending.push(makeMessage('tx', bytes, error))
    txFrames.value++
    scheduleFlush()
  }

  /** 添加一条文件下发气泡消息 */
  function addFileTransfer(transferId: string, _filename: string, _size: number) {
    txFrames.value++
    pending.push({
      id: nextId++,
      direction: 'tx',
      bytes: new Uint8Array(0),
      timestamp: Date.now(),
      kind: 'file',
      transferId
    })
    scheduleFlush()
  }

  /** 在指定消息之前插入分隔线（无 pending 阶段，直接写入已刷入的消息列表） */
  function insertDividerBefore(beforeId: number, text?: string) {
    const divider: Message = {
      id: nextId++,
      direction: 'tx',
      bytes: new Uint8Array(0),
      timestamp: Date.now(),
      kind: 'divider',
      note: text || undefined
    }
    const msgs = messages.value
    const idx = msgs.findIndex((m) => m.id === beforeId)
    if (idx >= 0) {
      const copy = msgs.slice()
      copy.splice(idx, 0, divider)
      messages.value = copy
    } else {
      messages.value = msgs.concat(divider)
    }
    triggerRef(messages)
  }

  /** 设置/清除指定帧的用户标注（note） */
  function setMessageNote(messageId: number, note: string | null) {
    const msgs = messages.value
    const idx = msgs.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const copy = msgs.slice()
    const m = { ...copy[idx] }
    if (note) m.note = note
    else delete m.note
    copy[idx] = m
    messages.value = copy
    triggerRef(messages)
  }

  function clear() {
    messages.value = []
    pending = []
    rxFrames.value = 0
    txFrames.value = 0
    rxErrorFrames.value = 0
    droppedFrames.value = 0
    triggerRef(messages)
  }

  /** 删除指定 id 的帧（批量删除用）；pending 里未刷入的不可见不可选，不动；rxFrames 是历史接收统计，不减 */
  function removeByIds(ids: number[]) {
    if (ids.length === 0) return
    const set = new Set(ids)
    messages.value = messages.value.filter((m) => !set.has(m.id))
    triggerRef(messages)
  }

  function togglePause() {
    deps.togglePause()
  }

  // 会话销毁清理：取消挂起的 rAF 批处理与 gap-timeout 尾帧定时器，避免回调打到已销毁状态。
  onScopeDispose(() => {
    decodeListeners.clear()
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
    if (gapTimer) {
      clearTimeout(gapTimer)
      gapTimer = null
    }
  })

  return { messages, paused, pauseStartTime, rxFrames, txFrames, rxErrorFrames, droppedFrames, ingestRx, addTx, addFileTransfer, insertDividerBefore, setMessageNote, clear, removeByIds, togglePause, onDecode }
}

/** 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。 */
export const useMessagesStore = defineStore('messages', () => {
  const s = useSettingsStore()
  const p = usePauseStore()
  const { paused, pauseStartTime } = storeToRefs(p)
  return createMessagesStore({
    settings: s.settings,
    // 单例无会话上下文：校验/帧解码保持默认（生产经 session 注入按端口配置）
    checksum: defaultChecksumConfig(),
    decoder: structuredClone(DEFAULT_DECODER_CONFIG),
    paused,
    pauseStartTime,
    togglePause: () => p.toggle(),
  })
})
