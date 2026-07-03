import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { useSettingsStore } from './settings'
import { useSerialStore } from './serial'
import { parseSamples } from '@/utils/byte-parser'
import type { WaveformParseConfig } from '@/types'

/**
 * 波形 store：订阅串口原始字节流 → 解析为多通道采样 → 历史/可视两层缓冲。
 *
 * 两层模型（区别于早期单一滑动窗口）：
 *  - history：完整保留的采样缓冲（[X, ch1, ch2, …]），上限 MAX_HISTORY，从头裁剪。
 *    这层保证「暂停后能回看历史」——旧数据不再被即时丢弃。
 *  - data：可视切片 = history 末尾向前偏移 viewOffset 个采样的 maxPoints 长度窗口。
 *    组件只渲染这层（chart.setData(data)），x 轴 auto-fit 即正确显示当前窗口。
 *  - viewOffset：从尾部向回偏移的采样数。0 = 跟随最新；>0 = 回看更早历史。
 *    运行中（!paused）恒为 0，随数据流入自动跟随最新；暂停后由拖拽调整。
 *
 * 用 shallowRef 持有大数组（避免数千元素深响应式开销，同 messages store 做法），
 * 组件通过 version 版本号感知更新——而非 watch 数组长度，因为窗口滚满后长度恒定。
 *
 * 订阅在 store 初始化时建立（早于 connect 也安全：listener 静等，连接后即有数据流入）。
 * 单例 store 生命周期 = 应用生命周期，缓冲受 MAX_HISTORY 约束，无需反订阅。
 *
 * 配置变更语义（关键）：
 *  - 解析配置（类型/字节序/通道数/偏移）变更 → 旧数据按旧配置解析、无法沿用，清空重建。
 *  - 采样率变更 → 仅重算所有 history 的 X 时间戳（不制造波形断点；回看时时间轴仍正确）。
 *  - 最大点数变更 → 即时重切可视窗口（maxPoints 现为「可视点数」，不再裁剪 history）。
 */
export const useWaveformStore = defineStore('waveform', () => {
  const settingsStore = useSettingsStore()
  const serial = useSerialStore()

  // 完整历史缓冲（上限受 MAX_HISTORY 约束，从头裁剪）
  const history = shallowRef<number[][]>(buildEmpty())
  // 可视切片（组件渲染这层）
  const data = shallowRef<number[][]>(buildEmpty())
  const paused = ref(false)
  // 从尾部向回偏移的采样数：0 = 跟随最新；暂停后拖拽增大以回看更早历史
  const viewOffset = ref(0)

  // 数据版本号：每次 ingest / 配置变更 / 拖拽后自增，作为组件刷新 uPlot 的信号。
  // 不能依赖 data[0].length：窗口滚满后长度恒为 maxPoints 不再变化，
  // watch(length) 会停止触发，导致图表不再刷新（数据其实在变）。
  const version = ref(0)

  // 跨回调承接的半截采样零头（非响应式）
  let carryover: Uint8Array = new Uint8Array(0)
  // 全局采样计数器（单调递增），决定 X 时间戳
  let sampleIndex = 0
  // 当前 history 第一个点对应的全局索引（裁剪后推进，用于采样率变更时重算 X）
  let windowStartIndex = 0
  // 首个采样到达时刻；-1 表示尚未有数据
  let startTime = -1

  /** 历史缓冲上限（常量）：~5min@640Hz、2 通道约 3MB，避免长会话无界内存增长。
   *  maxPoints 设置上限 100k，恒 ≤ 此值，回看总有余量。 */
  const MAX_HISTORY = 200_000

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

  /** 接收原始字节 → 解析 → 追加进 history → 重切可视窗口 */
  function ingest(bytes: Uint8Array) {
    if (paused.value) return
    const { perChannel, remainder } = parseSamples(bytes, parseCfg(), carryover)
    carryover = remainder
    const n = perChannel[0]?.length ?? 0
    if (n === 0) return

    if (startTime < 0) startTime = Date.now()
    const rate = Math.max(1, settingsStore.settings.waveform.sampleRate)
    const dt = 1000 / rate
    const cur = history.value

    for (let s = 0; s < n; s++) {
      const x = startTime + sampleIndex * dt
      cur[0].push(x)
      for (let c = 0; c < perChannel.length; c++) cur[c + 1].push(perChannel[c][s])
      sampleIndex++
    }
    trimHistory(cur)
    recomputeView()
  }

  /** history 超 MAX_HISTORY 则从头裁剪（保留最新、丢弃最旧） */
  function trimHistory(cur: number[][]) {
    if (cur[0].length <= MAX_HISTORY) return
    const drop = cur[0].length - MAX_HISTORY
    for (let i = 0; i < cur.length; i++) cur[i] = cur[i].slice(drop)
    windowStartIndex += drop
  }

  /**
   * 按 viewOffset + maxPoints 从 history 切出可视窗口写入 data，并自增版本号。
   * viewOffset 越界（history 变短或 maxPoints 变大）在此处 clamp，保证调用方安全。
   */
  function recomputeView() {
    const viewSize = Math.max(1, settingsStore.settings.waveform.maxPoints)
    const hist = history.value
    const histLen = hist[0].length
    const maxOffset = Math.max(0, histLen - viewSize)
    if (viewOffset.value > maxOffset) viewOffset.value = maxOffset
    if (viewOffset.value < 0) viewOffset.value = 0
    const end = histLen - viewOffset.value
    const start = Math.max(0, end - viewSize)
    data.value = hist.map((arr) => arr.slice(start, end))
    version.value++
  }

  /** 清空缓冲（计数器一并重置，X 轴从下一批采样重新起算） */
  function clear() {
    carryover = new Uint8Array(0)
    sampleIndex = 0
    windowStartIndex = 0
    startTime = -1
    viewOffset.value = 0
    history.value = buildEmpty()
    data.value = buildEmpty()
    version.value++
  }

  function togglePause() {
    paused.value = !paused.value
    // 恢复时回到最新（避免停留在历史里错过新数据）
    if (!paused.value) {
      viewOffset.value = 0
      recomputeView()
    }
  }

  /** 设置回看偏移（拖拽用）：clamp 到 [0, history-viewSize] 后重切窗口 */
  function setViewOffset(n: number) {
    viewOffset.value = n
    recomputeView()
  }

  /** 回到最新（"回到最新"按钮 / 恢复时用） */
  function resetView() {
    viewOffset.value = 0
    recomputeView()
  }

  // —— 配置变更响应 ——

  // 解析配置变更：旧数据按旧配置解析，无法沿用 → 清空重建
  watch(() => settingsStore.settings.waveform.parse, clear, { deep: true })

  // 采样率变更：重算所有 history 的 X 时间戳（保留波形连续性，不制造断点；
  // 重算全部而非仅可视窗口，否则回看历史时时间轴会错）
  watch(
    () => settingsStore.settings.waveform.sampleRate,
    (rate) => {
      if (startTime < 0) return
      const dt = 1000 / Math.max(1, rate)
      const xs = history.value[0]
      for (let i = 0; i < xs.length; i++) {
        xs[i] = startTime + (windowStartIndex + i) * dt
      }
      recomputeView()
    }
  )

  // 最大点数变更：现为「可视点数」→ 重切可视窗口（不再裁剪 history）
  watch(
    () => settingsStore.settings.waveform.maxPoints,
    () => {
      recomputeView()
    }
  )

  // 订阅原始字节流（在 messages store 帧切分之前的同一份字节）
  serial.onData((bytes) => ingest(bytes))

  return { data, history, version, paused, viewOffset, ingest, clear, togglePause, setViewOffset, resetView }
})
