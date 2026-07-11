import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef, watch } from 'vue'
import type { Direction, Message } from '@/types'
import { FrameSplitter } from '@/composables/useFrameSplitter'
import { useSettingsStore } from './settings'

export const useMessagesStore = defineStore('messages', () => {
  const settingsStore = useSettingsStore()

  // 用 shallowRef + 手动 triggerRef，避免逐条 push 触发深度响应式开销
  const messages = shallowRef<Message[]>([])
  const paused = ref(false)
  const pauseStartTime = ref(0)
  const rxFrames = ref(0)

  let nextId = 1
  const splitter = new FrameSplitter(settingsStore.settings.frame)

  // 待刷入的帧队列 + rAF 批处理句柄
  let pending: Message[] = []
  let rafHandle: number | null = null
  // gap-timeout 尾帧刷新定时器
  let gapTimer: ReturnType<typeof setTimeout> | null = null

  // 设置里帧策略变化时同步给切分器
  watch(
    () => settingsStore.settings.frame,
    (cfg) => splitter.setConfig({ ...cfg }),
    { deep: true }
  )

  function makeMessage(direction: Direction, bytes: Uint8Array, error?: string): Message {
    return { id: nextId++, direction, bytes, timestamp: Date.now(), error }
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
      const limit = settingsStore.settings.bufferLimit
      let next = messages.value.concat(pending)
      pending = []
      if (next.length > limit) next = next.slice(next.length - limit)
      messages.value = next
      triggerRef(messages)
    })
  }

  /** 接收原始字节：经帧切分后入队 */
  function ingestRx(bytes: Uint8Array) {
    if (paused.value) return
    const frames = splitter.push(bytes, Date.now())
    for (const f of frames) {
      pending.push(makeMessage('rx', f))
      rxFrames.value++
    }
    if (frames.length > 0) scheduleFlush()

    // gap-timeout：安排尾帧在静默 gapMs 后刷新
    const cfg = settingsStore.settings.frame
    if (cfg.strategy === 'gap-timeout') {
      if (gapTimer) clearTimeout(gapTimer)
      gapTimer = setTimeout(() => {
        const tail = splitter.flush()
        for (const f of tail) {
          pending.push(makeMessage('rx', f))
          rxFrames.value++
        }
        if (tail.length > 0) scheduleFlush()
      }, cfg.gapMs)
    }
  }

  /** 添加一条发送消息（TX 不切分，用户发什么就是一帧） */
  function addTx(bytes: Uint8Array, error?: string) {
    pending.push(makeMessage('tx', bytes, error))
    scheduleFlush()
  }

  /** 添加一条文件下发气泡消息 */
  function addFileTransfer(transferId: string, _filename: string, _size: number) {
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

  function clear() {
    messages.value = []
    pending = []
    rxFrames.value = 0
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
    paused.value = !paused.value
    if (paused.value) pauseStartTime.value = Date.now()
  }

  return { messages, paused, pauseStartTime, rxFrames, ingestRx, addTx, addFileTransfer, clear, removeByIds, togglePause }
})
