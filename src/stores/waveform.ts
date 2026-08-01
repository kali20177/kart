import { defineStore } from 'pinia'
import { ref, shallowRef, watch, onScopeDispose } from 'vue'
import { storeToRefs } from 'pinia'
import type { Ref } from 'vue'
import { useSettingsStore } from './settings'
import { useSerialStore } from './serial'
import { usePauseStore } from './pause'
import { TextLineParser, type WaveformParser } from '@/utils/waveform-parser'
import type { WaveformParseConfig } from '@/types'

/** waveform store 的外部依赖——原始字节流来自 serial.onData，波形配置来自全局设置，暂停与清空来自 pause。 */
export interface WaveformDeps {
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  settings: {
    waveform: {
      parse: WaveformParseConfig
      maxPoints: number
      maxHistoryPoints: number
    }
  }
  paused: Ref<boolean>
  pauseStartTime: Ref<number>
  togglePause: () => void
}

/**
 * 波形 store：订阅串口原始字节流 → 经 WaveformParser 解析为多通道采样 → 历史/可视两层缓冲。
 *
 * 解析器抽象：store 只持有单个 `parser: WaveformParser` 实例并通过接口委托，
 * 不感知协议细节（carryover 类型、标签索引、X 时间戳策略均封装在解析器内）。
 * 当前使用 TextLineParser（Arduino Serial.println 风格文本行）。
 * 未来新增协议（如二进制结构化字节流）：新增一个实现 WaveformParser 的解析器类，
 * 自带其 carryover 与 X 策略，store 的 ingest() 函数体无需改动——只换 parser 实例。
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
 *    zoomed 标志区分「未缩放（viewSize 跟随 maxPoints）」与「缩放中（viewSize 独立）」。
 *
 * 用 shallowRef 持有大数组（避免数千元素深响应式开销，同 messages store 做法），
 * 组件通过 version 版本号感知更新——而非 watch 数组长度，因为窗口滚满后长度恒定。
 *
 * 订阅在 store 初始化时建立（早于 connect 也安全：listener 静等，连接后即有数据流入）。
 * 单例 store 生命周期 = 应用生命周期，缓冲受 maxHistoryPoints 约束，无需反订阅。
 *
 * X 时间戳：由解析器用真实到达时间 Date.now() 构造（与消息时间戳对齐）。
 * 文本行到达速率未知且可变——Arduino Serial.println 间隔取决于 loop() 周期与
 * `delay()`，无法假设固定频率——故不用合成时间。
 * 同一批多行近似同时到达，逐行 +1ms 仅保单调（uPlot 要求 X 严格递增）。
 */
export function createWaveformStore(deps: WaveformDeps) {
  // 应用级全局暂停（与消息视图共享）——见 pause store 说明。
  const { paused, pauseStartTime } = deps

  // 通道标签名（响应式，供组件绑定图例/按钮/tooltip）。
  // 必须在 history/data 初始化之前声明 —— buildEmpty() 参考它。
  const textLabels = ref<string[]>([])

  // 当前通道数（响应式）：取 textLabels 长度和 history 实际形状的最大值，
  // 确保无标签数据也能被正确渲染。
  // 注意 history 是 shallowRef，通道数变化时要用 version 驱动重算。
  const channelCount = ref(1)

  // 完整历史缓冲（上限受 maxHistoryPoints 约束，从头裁剪）
  const history = shallowRef<number[][]>(buildEmpty())
  // 可视切片（组件渲染这层）
  const data = shallowRef<number[][]>(buildEmpty())
  // 从尾部向回偏移的采样数：0 = 跟随最新；暂停后拖拽增大以回看更早历史
  const viewOffset = ref(0)
  // 可视窗口跨度（采样数）：默认 = maxPoints；滚轮缩放时独立变化（zoomed=true）。
  // 运行中改它 = 时基缩放（仍跟随最新）；暂停时改它 = 光标锚定放大某段历史。
  const viewSize = ref(deps.settings.waveform.maxPoints)
  const zoomed = ref(false)

  // 数据版本号：每次 ingest / 配置变更 / 拖拽后自增，作为组件刷新 uPlot 的信号。
  // 不能依赖 data[0].length：窗口滚满后长度恒为 maxPoints 不再变化，
  // watch(length) 会停止触发，导致图表不再刷新（数据其实在变）。
  const version = ref(0)

  // 解析器实例（自持 carryover / labelIndex / lastSampleX 等协议状态）。
  // 切换协议 = 换实例 + clear()；当前固定为文本行解析器。
  const parser: WaveformParser = new TextLineParser()
  // 暂停恢复断点 X 值（毫秒）；-1 表示无活跃断点
  const resumeBreakX = ref(-1)

  /** 可视窗口跨度下限（常量）：滚轮放大最深至此（约 2 个采样），maxPoints 设置下限 100 恒大于此。
   *  可按需调大（如 10）以避免极小窗口的退化视图。 */
  const MIN_VIEW = 2

  /** 按当前有效通道数构造空数据：[X, ch1, ch2, …]
   *  通道数 = max(1, channelCount)，初始为 [X, CH1]，随数据到达动态增长。 */
  function buildEmpty(): number[][] {
    const ch = Math.max(1, channelCount.value)
    const arr: number[][] = []
    for (let i = 0; i <= ch; i++) arr.push([])
    return arr
  }

  /**
   * 接收原始字节 → 解析器解析 → 追加进 history → 重切可视窗口
   *
   * 通道数检测：解析结果 perChannel.length 即为实际通道数；
   * channelCount 在数据到达时自动更新，覆盖无标签（如 `214,920`）
   * 和有标签（Sin:0.5,Cos:0.86）两种场景。 */
  function ingest(bytes: Uint8Array) {
    if (paused.value) return
    const { xs, perChannel } = parser.ingest(bytes, Date.now())

    // 同步 parser.labels → textLabels：新标签出现时自动追加
    const labels = parser.labels
    if (labels.length !== textLabels.value.length) {
      textLabels.value = labels.slice()
    }

    const n = xs.length
    if (n === 0) return

    const cur = history.value

    // 动态通道增长（新标签出现 / 无标签多 token → perChannel 可能 > cur 通道数）
    // 补足空数组，使 cur[c+1] 可安全 push
    while (cur.length <= perChannel.length) {
      cur.push([])
    }

    // 同步 channelCount：取 textLabels.length 和 perChannel.length 的最大值，
    // 让组件在无标签数据（如 `214,920`）到达时也能检测到通道数变化。
    const chNow = Math.max(textLabels.value.length, perChannel.length)
    if (chNow !== channelCount.value) channelCount.value = chNow

    for (let s = 0; s < n; s++) {
      cur[0].push(xs[s])
      for (let c = 0; c < perChannel.length; c++) cur[c + 1].push(perChannel[c][s])
    }
    trimHistory(cur)
    recomputeView()
  }

  /** history 超过 maxHistoryPoints 则从头裁剪（保留最新、丢弃最旧）。
   *  上限可配置（设置 ▸ 波形解析 ▸ 历史缓冲上限），默认 200k；
   *  UI min 锁定 maxPoints，故恒 ≥ 可视窗口，回看总有余量。 */
  function trimHistory(cur: number[][]) {
    const maxHistory = deps.settings.waveform.maxHistoryPoints
    if (cur[0].length <= maxHistory) return
    const drop = cur[0].length - maxHistory
    for (let i = 0; i < cur.length; i++) cur[i] = cur[i].slice(drop)
  }

  /**
   * 按 viewOffset + viewSize 从 history 切出可视窗口写入 data，并自增版本号。
   * viewSize 默认 = maxPoints，滚轮缩放后独立变化；此处一并 clamp 到 [MIN_VIEW, maxPoints]。
   * viewOffset 越界（history 变短或 viewSize 变大）在此处 clamp，保证调用方安全。
   */
  function recomputeView() {
    const mp = deps.settings.waveform.maxPoints
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

  /** 清空缓冲（解析器状态、通道数、计数器一并重置；X 轴从下一批采样重新起算；缩放一并重置） */
  function clear() {
    parser.reset()
    textLabels.value = []
    channelCount.value = 1
    resumeBreakX.value = -1
    viewOffset.value = 0
    viewSize.value = deps.settings.waveform.maxPoints
    zoomed.value = false
    history.value = buildEmpty()
    data.value = buildEmpty()
    version.value++
  }

  function togglePause() {
    const wasPaused = paused.value
    deps.togglePause()
    if (wasPaused) {
      // 从暂停 → 运行：回到最新（避免停留在历史里错过新数据），并记录恢复断点。
      // 断点 = history 末尾采样 X（暂停前最后一个真实时刻），从 history 读取而非解析器内部状态。
      const xs = history.value[0]
      resumeBreakX.value = xs.length > 0 ? xs[xs.length - 1] : -1
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
    const mp = deps.settings.waveform.maxPoints
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
    viewSize.value = deps.settings.waveform.maxPoints
    recomputeView()
  }

  // —— 配置变更响应 ——

  // 解析配置变更：旧数据按旧配置解析，无法沿用 → 清空重建（parser.reset()）。
  // 未来新增协议字段时，在此 watch 内按新协议重建 parser 实例（如 parser = createParser(cfg)），
  // 再 clear()；ingest() 函数体无需改动。
  watch(() => deps.settings.waveform.parse, clear, { deep: true })

  // 最大点数变更：现为「可视点数」→ 未缩放时 viewSize 跟随新 maxPoints；
  // 缩放中保持用户倍率，仅 clamp 到新 [MIN_VIEW, maxPoints]。随后重切可视窗口。
  watch(
    () => deps.settings.waveform.maxPoints,
    () => {
      const mp = deps.settings.waveform.maxPoints
      if (!zoomed.value) viewSize.value = mp
      else viewSize.value = Math.min(Math.max(viewSize.value, MIN_VIEW), mp)
      recomputeView()
    }
  )

  // 历史缓冲上限变更：改小立即从头裁剪 history（丢弃最旧）；改大无副作用。随后重切可视窗口。
  watch(
    () => deps.settings.waveform.maxHistoryPoints,
    () => {
      trimHistory(history.value)
      recomputeView()
    }
  )

  // 订阅原始字节流（在 messages store 帧切分之前的同一份字节）。
  // 保存退订函数以便会话销毁时取消订阅。
  let _unsubData: (() => void) | null = null
  _unsubData = deps.onData((bytes) => ingest(bytes))
  onScopeDispose(() => {
    _unsubData?.()
    _unsubData = null
  })

  return { data, history, version, paused, pauseStartTime, resumeBreakX, viewOffset, viewSize, zoomed, textLabels, channelCount, ingest, clear, togglePause, setViewOffset, resetView, zoom, resetZoom }
}

/** 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。 */
export const useWaveformStore = defineStore('waveform', () => {
  const serial = useSerialStore()
  const s = useSettingsStore()
  const p = usePauseStore()
  const { paused, pauseStartTime } = storeToRefs(p)
  return createWaveformStore({
    onData: (cb) => serial.onData(cb),
    settings: s.settings,
    paused,
    pauseStartTime,
    togglePause: () => p.toggle(),
  })
})
