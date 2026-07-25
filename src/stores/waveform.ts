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
 *  - history：完整保留的采样缓冲（[X, ch1, ch2, …]），上限为用户配置的 maxHistoryPoints，从头裁剪。
 *    这层保证「暂停后能回看历史」——旧数据不再被即时丢弃。
 *  - data：可视切片 = history 末尾向前偏移 viewOffset 个采样的 viewSize 长度窗口。
 *    组件只渲染这层（chart.setData(data)），x 轴 auto-fit 即正确显示当前窗口。
 *  - viewOffset：从尾部向回偏移的采样数。0 = 跟随最新；>0 = 回看更早历史。
 *    运行中（!paused）恒为 0，随数据流入自动跟随最新；暂停后由拖拽调整。
 *  - viewSize：可视窗口跨度（显示多少个采样）。默认 = maxPoints；滚轮缩放可改，
 *    放大取更少但更密集的真实采样 → 看到真实细节（示波器时基缩放）。
 *    与 viewOffset 正交：viewOffset 是窗口位置、viewSize 是窗口跨度，共同定义窗口几何。
 *    zoomed 标志区分「未缩放（viewSize 跟随 maxPoints）」与「缩放中（viewSize 独立）」。
 *
 * 用 shallowRef 持有大数组（避免数千元素深响应式开销，同 messages store 做法），
 * 组件通过 version 版本号感知更新——而非 watch 数组长度，因为窗口滚满后长度恒定。
 *
 * 订阅在 store 初始化时建立（早于 connect 也安全：listener 静等，连接后即有数据流入）。
 * 单例 store 生命周期 = 应用生命周期，缓冲受 maxHistoryPoints 约束，无需反订阅。
 *
 * 配置变更语义（关键）：
 *  - 解析配置（类型/字节序/通道数/偏移）变更 → 旧数据按旧配置解析、无法沿用，清空重建。
 *  - 采样率变更 → 仅重算所有 history 的 X 时间戳（不制造波形断点；回看时时间轴仍正确）。
 *  - 最大点数变更 → 未缩放时 viewSize 跟随新 maxPoints、缩放中仅 clamp；即时重切可视窗口
 *    （maxPoints 现为「默认可视点数」，不再裁剪 history）。
 */
export const useWaveformStore = defineStore('waveform', () => {
  const settingsStore = useSettingsStore()
  const serial = useSerialStore()

  // 完整历史缓冲（上限受 maxHistoryPoints 约束，从头裁剪）
  const history = shallowRef<number[][]>(buildEmpty())
  // 可视切片（组件渲染这层）
  const data = shallowRef<number[][]>(buildEmpty())
  const paused = ref(false)
  const pauseStartTime = ref(0)
  // 从尾部向回偏移的采样数：0 = 跟随最新；暂停后拖拽增大以回看更早历史
  const viewOffset = ref(0)
  // 可视窗口跨度（采样数）：默认 = maxPoints；滚轮缩放时独立变化（zoomed=true）。
  // 运行中改它 = 时基缩放（仍跟随最新）；暂停时改它 = 光标锚定放大某段历史。
  const viewSize = ref(settingsStore.settings.waveform.maxPoints)
  const zoomed = ref(false)

  // 数据版本号：每次 ingest / 配置变更 / 拖拽后自增，作为组件刷新 uPlot 的信号。
  // 不能依赖 data[0].length：窗口滚满后长度恒为 maxPoints 不再变化，
  // watch(length) 会停止触发，导致图表不再刷新（数据其实在变）。
  const version = ref(0)

  // 跨回调承接的半截采样零头（非响应式）
  let carryover: Uint8Array = new Uint8Array(0)
  // 暂停恢复断点 X 值（毫秒）；-1 表示无活跃断点
  const resumeBreakX = ref(-1)
  // 全局采样计数器（单调递增），决定 X 时间戳
  let sampleIndex = 0
  // 当前 history 第一个点对应的全局索引（裁剪后推进，用于采样率变更时重算 X）
  let windowStartIndex = 0
  // 首个采样到达时刻；-1 表示尚未有数据
  let startTime = -1

  /** 可视窗口跨度下限（常量）：滚轮放大最深至此（约 2 个采样），maxPoints 设置下限 100 恒大于此。
   *  可按需调大（如 10）以避免极小窗口的退化视图。 */
  const MIN_VIEW = 2

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

  /** history 超过 maxHistoryPoints 则从头裁剪（保留最新、丢弃最旧）。
   *  上限可配置（设置 ▸ 波形解析 ▸ 历史缓冲上限），默认 200k（~5min@640Hz、2 通道约 3MB）；
   *  UI min 锁定 maxPoints，故恒 ≥ 可视窗口，回看总有余量。 */
  function trimHistory(cur: number[][]) {
    const maxHistory = settingsStore.settings.waveform.maxHistoryPoints
    if (cur[0].length <= maxHistory) return
    const drop = cur[0].length - maxHistory
    for (let i = 0; i < cur.length; i++) cur[i] = cur[i].slice(drop)
    windowStartIndex += drop
  }

  /**
   * 按 viewOffset + viewSize 从 history 切出可视窗口写入 data，并自增版本号。
   * viewSize 默认 = maxPoints，滚轮缩放后独立变化；此处一并 clamp 到 [MIN_VIEW, maxPoints]。
   * viewOffset 越界（history 变短或 viewSize 变大）在此处 clamp，保证调用方安全。
   */
  function recomputeView() {
    const mp = settingsStore.settings.waveform.maxPoints
    const size = Math.min(Math.max(viewSize.value, MIN_VIEW), mp)
    if (viewSize.value !== size) viewSize.value = size
    const hist = history.value
    const histLen = hist[0].length
    const maxOffset = Math.max(0, histLen - size)
    if (viewOffset.value > maxOffset) viewOffset.value = maxOffset
    if (viewOffset.value < 0) viewOffset.value = 0
    const end = histLen - viewOffset.value
    const start = Math.max(0, end - size)
    data.value = hist.map((arr) => arr.slice(start, end))
    version.value++
  }

  /** 清空缓冲（计数器一并重置，X 轴从下一批采样重新起算；缩放一并重置） */
  function clear() {
    carryover = new Uint8Array(0)
    resumeBreakX.value = -1
    sampleIndex = 0
    windowStartIndex = 0
    startTime = -1
    viewOffset.value = 0
    viewSize.value = settingsStore.settings.waveform.maxPoints
    zoomed.value = false
    history.value = buildEmpty()
    data.value = buildEmpty()
    version.value++
  }

  function togglePause() {
    paused.value = !paused.value
    if (paused.value) pauseStartTime.value = Date.now()
    // 恢复时回到最新（避免停留在历史里错过新数据）
    if (!paused.value) {
      // 计算断点 X：下一个采样将被放置的位置
      const rate = Math.max(1, settingsStore.settings.waveform.sampleRate)
      const dt = 1000 / rate
      resumeBreakX.value = startTime >= 0 ? startTime + sampleIndex * dt : -1
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

  /**
   * 滚轮缩放：改变可视窗口跨度 viewSize（从 history 取更多/更少真实采样）。
   *  - factor<1 放大（viewSize 减小，看到更密集的真实细节）；factor>1 缩小。
   *  - anchorFraction==null（运行中）：锚定右边缘（最新），viewOffset 恒 0 —— 时基缩放，
   *    数据流入仍跟随最新；不与自动跟随冲突（故运行中亦可缩放，区别于仅暂停可用的 pan）。
   *  - anchorFraction 有值（暂停）：光标锚定——光标下采样保持在同分数位置，
   *    同时调整 viewSize 与 viewOffset，放大目标不跑偏（示波器时基缩放的标准交互）。
   *  - newSize 撞 maxPoints → zoomed 归 false（缩放回到默认窗口）；撞 MIN_VIEW 不再变。
   */
  function zoom(factor: number, anchorFraction: number | null) {
    const mp = settingsStore.settings.waveform.maxPoints
    const oldSize = Math.min(Math.max(viewSize.value, MIN_VIEW), mp)
    let newSize = Math.round(oldSize * factor)
    newSize = Math.min(Math.max(newSize, MIN_VIEW), mp)
    if (newSize === oldSize) return
    const histLen = history.value[0].length
    if (anchorFraction !== null && histLen > 0) {
      // 光标锚定：锚点采样 = oldEnd - (1-f)*oldSize；放大后令其仍处于同分数 f
      const f = Math.min(Math.max(anchorFraction, 0), 1)
      const oldEnd = histLen - viewOffset.value // 可视窗口右边缘（exclusive）
      const anchorIdx = oldEnd - (1 - f) * oldSize
      const newEnd = anchorIdx + (1 - f) * newSize
      let newOffset = Math.round(histLen - newEnd)
      const maxOffset = Math.max(0, histLen - newSize)
      if (newOffset < 0) newOffset = 0
      if (newOffset > maxOffset) newOffset = maxOffset
      viewOffset.value = newOffset
    } else {
      // 运行中：保持跟随最新
      viewOffset.value = 0
    }
    viewSize.value = newSize
    zoomed.value = newSize < mp
    recomputeView()
  }

  /** 重置缩放（"重置缩放"按钮用）：viewSize 回到 maxPoints */
  function resetZoom() {
    zoomed.value = false
    viewSize.value = settingsStore.settings.waveform.maxPoints
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

  // 最大点数变更：现为「可视点数」→ 未缩放时 viewSize 跟随新 maxPoints；
  // 缩放中保持用户倍率，仅 clamp 到新 [MIN_VIEW, maxPoints]。随后重切可视窗口。
  watch(
    () => settingsStore.settings.waveform.maxPoints,
    () => {
      const mp = settingsStore.settings.waveform.maxPoints
      if (!zoomed.value) viewSize.value = mp
      else viewSize.value = Math.min(Math.max(viewSize.value, MIN_VIEW), mp)
      recomputeView()
    }
  )

  // 历史缓冲上限变更：改小立即从头裁剪 history（丢弃最旧）；改大无副作用。随后重切可视窗口。
  watch(
    () => settingsStore.settings.waveform.maxHistoryPoints,
    () => {
      trimHistory(history.value)
      recomputeView()
    }
  )

  // 订阅原始字节流（在 messages store 帧切分之前的同一份字节）
  serial.onData((bytes) => ingest(bytes))

  return { data, history, version, paused, pauseStartTime, resumeBreakX, viewOffset, viewSize, zoomed, ingest, clear, togglePause, setViewOffset, resetView, zoom, resetZoom }
})
