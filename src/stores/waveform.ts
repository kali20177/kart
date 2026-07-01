import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { useSettingsStore } from './settings'
import { useSerialStore } from './serial'
import { parseSamples } from '@/utils/byte-parser'
import type { WaveformParseConfig } from '@/types'

/**
 * 波形 store：订阅串口原始字节流 → 解析为多通道采样 → 滑动窗口缓冲。
 *
 * 数据结构 data[0]=X 时间戳，data[1..channels]=各通道 Y。用 shallowRef 持有大数组
 * （避免数千元素深响应式开销，同 messages store 做法），组件通过 version 版本号
 * 感知更新——而非 watch 数组长度，因为窗口滚满后长度恒定。
 *
 * 订阅在 store 初始化时建立（早于 connect 也安全：listener 静等，连接后即有数据流入）。
 * 单例 store 生命周期 = 应用生命周期，缓冲受 maxPoints 约束，无需反订阅。
 *
 * 配置变更语义（关键）：
 *  - 解析配置（类型/字节序/通道数/偏移）变更 → 旧数据按旧配置解析、无法沿用，清空重建。
 *  - 采样率变更 → 仅重算所有 X 时间戳，不制造波形断点。
 *  - 最大点数变更 → 即时从头裁剪。
 */
export const useWaveformStore = defineStore('waveform', () => {
  const settingsStore = useSettingsStore()
  const serial = useSerialStore()

  const data = shallowRef<number[][]>(buildEmpty())
  const paused = ref(false)

  // 数据版本号：每次 ingest / 配置变更后自增，作为组件刷新 uPlot 的信号。
  // 不能依赖 data[0].length：窗口滚满后长度恒为 maxPoints 不再变化，
  // watch(length) 会停止触发，导致图表不再刷新（数据其实在变）。
  const version = ref(0)

  // 跨回调承接的半截采样零头（非响应式）
  let carryover: Uint8Array = new Uint8Array(0)
  // 全局采样计数器（单调递增），决定 X 时间戳
  let sampleIndex = 0
  // 当前窗口第一个点对应的全局索引（裁剪后推进，用于采样率变更时重算 X）
  let windowStartIndex = 0
  // 首个采样到达时刻；-1 表示尚未有数据
  let startTime = -1

  function parseCfg(): WaveformParseConfig {
    return settingsStore.settings.waveform.parse
  }

  /** 按当前通道数构造空数据：[X, ch1, ch2, …] */
  function buildEmpty(): number[][] {
    const ch = Math.max(1, parseCfg().channels)
    const arr: number[][] = []
    for (let i = 0; i <= ch; i++) arr.push([])
    return arr
  }

  /** 接收原始字节 → 解析 → 按通道追加进滑动窗口 */
  function ingest(bytes: Uint8Array) {
    if (paused.value) return
    const { perChannel, remainder } = parseSamples(bytes, parseCfg(), carryover)
    carryover = remainder
    const n = perChannel[0]?.length ?? 0
    if (n === 0) return

    if (startTime < 0) startTime = Date.now()
    const rate = Math.max(1, settingsStore.settings.waveform.sampleRate)
    const dt = 1000 / rate
    const cur = data.value

    for (let s = 0; s < n; s++) {
      const x = startTime + sampleIndex * dt
      cur[0].push(x)
      for (let c = 0; c < perChannel.length; c++) cur[c + 1].push(perChannel[c][s])
      sampleIndex++
    }
    trimIfNeeded(cur)
    version.value++
  }

  /** 超过 maxPoints 则从头裁剪（滚动窗口） */
  function trimIfNeeded(cur: number[][]) {
    const max = Math.max(1, settingsStore.settings.waveform.maxPoints)
    if (cur[0].length <= max) return
    const drop = cur[0].length - max
    for (let i = 0; i < cur.length; i++) cur[i] = cur[i].slice(drop)
    windowStartIndex += drop
  }

  /** 清空缓冲（计数器一并重置，X 轴从下一批采样重新起算） */
  function clear() {
    carryover = new Uint8Array(0)
    sampleIndex = 0
    windowStartIndex = 0
    startTime = -1
    data.value = buildEmpty()
    version.value++
  }

  function togglePause() {
    paused.value = !paused.value
  }

  // —— 配置变更响应 ——

  // 解析配置变更：旧数据按旧配置解析，无法沿用 → 清空重建
  watch(() => settingsStore.settings.waveform.parse, clear, { deep: true })

  // 采样率变更：重算所有 X 时间戳（保留波形连续性，不制造断点）
  watch(
    () => settingsStore.settings.waveform.sampleRate,
    (rate) => {
      if (startTime < 0) return
      const dt = 1000 / Math.max(1, rate)
      const xs = data.value[0]
      for (let i = 0; i < xs.length; i++) {
        xs[i] = startTime + (windowStartIndex + i) * dt
      }
      version.value++
    }
  )

  // 最大点数变更：即时裁剪
  watch(
    () => settingsStore.settings.waveform.maxPoints,
    () => {
      trimIfNeeded(data.value)
      version.value++
    }
  )

  // 订阅原始字节流（在 messages store 帧切分之前的同一份字节）
  serial.onData((bytes) => ingest(bytes))

  return { data, version, paused, ingest, clear, togglePause }
})
