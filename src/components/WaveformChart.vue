<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { NButton, NTag, NDropdown, NTooltip } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/composables/useSession'
import { useTheme } from '@/composables/useTheme'
import { formatTimestamp } from '@/utils/message-format'
import { exportWaveformAsCsv } from '@/utils/export-waveform-csv'
import { downloadTextFile } from '@/utils/download'
import type { WaveformParseConfig } from '@/types'

const { waveform, settings, pause: pauseStore } = useSession()
const { isDark } = useTheme()
const { t } = useI18n()

const containerRef = ref<HTMLDivElement | null>(null)

/** dockview 面板内容组件 props：params.api 携带面板激活状态（与 TerminalPane 一致）。 */
interface WaveformPanelParams {
  api?: {
    isActive: boolean
    onDidActiveChange: (cb: (e: { isActive: boolean }) => void) => { dispose(): void }
  }
}
const props = defineProps<{ params?: WaveformPanelParams }>()

// 通道配色：按通道数均分色相环，保证任意通道数下颜色不重复
function channelColor(index: number, total: number): string {
  const hue = total > 1 ? (index / total) * 360 : 0
  return `hsl(${hue.toFixed(1)}, 65%, 55%)`
}

// uPlot 用 export = 导出，默认导入即兼得值与命名空间类型（uPlot.Options / uPlot.Series …）
let chart: uPlot | null = null
let ro: ResizeObserver | null = null
let rafId: number | null = null
let lastW = 0
let lastH = 0
let apiSub: { dispose(): void } | null = null

// 光标 tooltip 状态
const tooltipVisible = ref(false)
const tooltipBelow = ref(false)
const tooltipX = ref(0)
const tooltipY = ref(0)
const tooltipTime = ref('')
const tooltipValues = ref<{ label: string; value: string; color: string }[]>([])
const tooltipRef = ref<HTMLDivElement | null>(null)

// 通道可见性：boolean[] 长度 = 当前通道数，true=可见
const channelVisible = ref<boolean[]>([])

/** 确保 channelVisible 长度与通道数一致（新增默认可见，多余丢弃） */
function syncChannelVisibility() {
  const ch = channels()
  const arr = channelVisible.value
  while (arr.length < ch) arr.push(true)
  if (arr.length > ch) arr.length = ch
}

/** 切换单个通道可见性：直接操作 uPlot series 显隐，不重建图表 */
function toggleChannel(i: number) {
  const arr = channelVisible.value
  if (i < 0 || i >= arr.length) return
  arr[i] = !arr[i]
  if (chart) chart.setSeries(i + 1, { show: arr[i] })
}

/** 将所有通道的可见性应用到当前 uPlot 实例（重建后调用） */
function applyChannelVisible() {
  if (!chart) return
  const arr = channelVisible.value
  for (let i = 0; i < arr.length; i++) {
    chart.setSeries(i + 1, { show: arr[i] })
  }
}

/** 从 tokens.css 读主题色 —— uPlot 不吃 CSS 变量，需 JS 读 computed style */
function cssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function themeColors() {
  return {
    border: cssVar('--border') || '#2f3136',
    textDim: cssVar('--text-dim') || '#7a808b'
  }
}

/** 格式化单个采样值：整数直接显示，浮点保留适当精度；NaN（短行缺口）显示 '-' */
function formatSampleValue(v: number, _cfg: WaveformParseConfig): string {
  if (Number.isNaN(v)) return '-'
  if (Number.isInteger(v)) return String(v)
  // 文本模式数值为任意浮点（如 analogRead / 传感器读数），按浮点格式化
  if (Math.abs(v) < 0.001 && v !== 0) return v.toExponential(3)
  return v.toFixed(Math.abs(v) < 1000 ? 4 : 2)
}

/** 通道标签名：优先取 textLabels[i]，回退到 CH1/CH2 */
function channelLabel(i: number): string {
  return waveform.textLabels[i] ?? `${t('waveform.ch')}${i + 1}`
}

function channels(): number {
  // 通道数 = max(标签数, 解析器实际检测到的通道数)；
  // channelCount 随数据到达按 perChannel.length 动态增长，
  // 覆盖无标签多 token 场景（如 `214,920`）和标签化场景。
  return Math.max(1, waveform.channelCount)
}
function drawResumeBreak(u: uPlot) {
  const x = waveform.resumeBreakX
  if (x <= 0) return
  const xScale = u.scales.x
  if (!xScale || xScale.min == null || xScale.max == null || x < xScale.min || x > xScale.max) return

  const px = u.valToPos(x, 'x')
  const top = u.bbox.top
  const h = u.bbox.height
  const ctx = u.ctx

  ctx.save()
  ctx.beginPath()
  ctx.setLineDash([6, 4])
  ctx.strokeStyle = '#ff8800'
  ctx.lineWidth = 1.5
  ctx.moveTo(px, top)
  ctx.lineTo(px, top + h)
  ctx.stroke()

  ctx.font = '11px sans-serif'
  ctx.fillStyle = '#ff8800'
  ctx.textAlign = 'center'
  ctx.fillText(t('waveform.breakLabel'), px, top + h - 4)
  ctx.restore()
}

/** 光标移动时更新 tooltip：读取各通道值并定位浮动提示 */
function onSetCursor(u: uPlot) {
  const idx = u.cursor.idx
  if (idx == null || idx < 0 || panActive) {
    tooltipVisible.value = false
    return
  }
  const ch = channels()
  const vals: { label: string; value: string; color: string }[] = []
  for (let i = 0; i < ch; i++) {
    if (!channelVisible.value[i]) continue
    const v = u.data[i + 1]?.[idx]
    if (v != null) {
      vals.push({
        label: channelLabel(i),
        value: formatSampleValue(v as number, settings.waveform.parse),
        color: channelColor(i, ch)
      })
    }
  }
  if (vals.length === 0) {
    tooltipVisible.value = false
    return
  }
  tooltipValues.value = vals
  tooltipTime.value = formatTimestamp(u.data[0][idx] as number, 'short')

  // u.cursor.left/top 相对于 uPlot 绘图区，需加上 over 在 container 内的偏移
  const overRect = u.over.getBoundingClientRect()
  const containerRect = containerRef.value!.getBoundingClientRect()
  let cx = overRect.left - containerRect.left + u.cursor.left!
  const cy = overRect.top - containerRect.top + u.cursor.top!
  // 顶部空间不足 -> 翻转到光标下方（transform 同步切到 translate(-50%, 0)，锚点变顶边中点）
  const below = cy < 52
  // 水平 clamp：tooltip 居中于 cx，半宽超出容器时贴边。
  // 首帧 v-show=false（display:none）offsetWidth 为 0 -> 跳过 clamp，后续帧补上。
  const halfW = (tooltipRef.value?.offsetWidth ?? 0) / 2
  const cw = containerRect.width
  if (halfW > 0 && cw > 0) cx = Math.min(Math.max(cx, halfW), cw - halfW)
  tooltipX.value = cx
  tooltipBelow.value = below
  tooltipY.value = below ? cy + 12 : cy - 12
  tooltipVisible.value = true
}

function buildOpts(ch: number, w: number, h: number): uPlot.Options {
  const c = themeColors()
  const series: uPlot.Series[] = [
    {}, // X（时间）系列 —— uPlot 约定 index 0
    ...Array.from({ length: ch }, (_, i) => ({
      label: `CH${i + 1}`,
      stroke: channelColor(i, ch),
      width: 1.5,
      points: { show: false },
      spanGaps: true
    }))
  ]
  return {
    class: 'uplot-wrap',
    width: w,
    height: h,
    series,
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      {
        stroke: c.textDim,
        grid: { stroke: c.border, width: 1 },
        ticks: { stroke: c.border, width: 1 }
      },
      {
        stroke: c.textDim,
        grid: { stroke: c.border, width: 1 },
        ticks: { stroke: c.border, width: 1 },
        size: 56
      }
    ],
    // 光标：X 轴锁定垂直竖线，不显示数据点标记，禁用 uPlot 自带拖拽缩放
    cursor: {
      show: true,
      x: true,
      y: false,
      points: { show: false },
      drag: { setScale: false, x: false, y: false }
    },
    hooks: {
      draw: [drawResumeBreak],
      setCursor: [onSetCursor]
    }
  }
}

function destroyChart() {
  if (chart) {
    unbindPan()
    unbindZoom()
    chart.destroy()
    chart = null
  }
}

/** 按当前主题 + 通道数重建实例（首挂载 / 主题切换 / 通道数变更时） */
function rebuild() {
  const el = containerRef.value
  if (!el) return
  destroyChart()
  syncChannelVisibility()
  const w = el.clientWidth || lastW || 600
  const h = el.clientHeight || lastH || 300
  lastW = w
  lastH = h
  const opts = buildOpts(channels(), w, h)
  chart = new uPlot(opts, waveform.data as unknown as uPlot.AlignedData, el)
  applyChannelVisible()
  bindPan()
  bindZoom()
}

// —— 暂停时拖拽回看历史（grab 式平移）——
// uPlot 1.6 无内置 pan 插件，自实现 pointerdown/move/up 于 chart.over 覆盖层。
// 仅 paused 时启用；向右拖 → viewOffset 增大 → 看更早历史，1:1 跟手。
let panActive = false
let panStartX = 0
let panStartOffset = 0

function onPanDown(e: PointerEvent) {
  if (!chart || !waveform.paused) return
  e.preventDefault()
  tooltipVisible.value = false
  panActive = true
  panStartX = e.clientX
  panStartOffset = waveform.viewOffset
  const over = chart.over
  try {
    over.setPointerCapture(e.pointerId)
  } catch {
    /* 无 pointer capture 时退化为仅 over 内移动 */
  }
  over.style.cursor = 'grabbing'
  over.addEventListener('pointermove', onPanMove)
  over.addEventListener('pointerup', onPanUp)
  over.addEventListener('pointercancel', onPanUp)
}

function onPanMove(e: PointerEvent) {
  if (!panActive || !chart) return
  const plotW = chart.over.clientWidth
  if (plotW <= 0) return
  // 用当前可视窗口跨度 viewSize（缩放后会小于 maxPoints），否则缩放后拖拽会快 N 倍、不再 1:1 跟手
  const viewSize = Math.max(1, waveform.viewSize)
  const dx = e.clientX - panStartX
  // samplesPerPx = 可视点数 / 绘图区像素宽 → 像素位移换算为采样位移，1:1 跟手
  const samplesPerPx = viewSize / plotW
  const target = Math.round(panStartOffset + dx * samplesPerPx)
  waveform.setViewOffset(target)
}

function onPanUp(e: PointerEvent) {
  if (!chart) return
  const over = chart.over
  panActive = false
  try {
    over.releasePointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  over.style.cursor = waveform.paused ? 'grab' : ''
  over.removeEventListener('pointermove', onPanMove)
  over.removeEventListener('pointerup', onPanUp)
  over.removeEventListener('pointercancel', onPanUp)
}

/** 重建后挂 pan 监听 + 设初始光标 */
function bindPan() {
  if (!chart) return
  const over = chart.over
  over.addEventListener('pointerdown', onPanDown)
  over.style.cursor = waveform.paused ? 'grab' : ''
}

function unbindPan() {
  if (!chart) return
  const over = chart.over
  over.removeEventListener('pointerdown', onPanDown)
  over.removeEventListener('pointermove', onPanMove)
  over.removeEventListener('pointerup', onPanUp)
  over.removeEventListener('pointercancel', onPanUp)
  panActive = false
}

// —— 滚轮缩放（运行中 + 暂停均可）——
// 改可视窗口跨度 viewSize（从 history 取更多/更少真实采样），放大露出真实细节（示波器时基缩放）。
// 运行中锚定最新（viewOffset 恒 0，仍自动跟随）；暂停时光标锚定（光标下采样不跑偏）。
// 非被动监听以允许 preventDefault 阻止页面滚动 / 浏览器 ctrl+wheel 页面缩放。
const ZOOM_STEP = 0.0018 // factor = exp(deltaY * STEP)：wheel up（deltaY<0）→ factor<1 → 放大；notch≈1.2×，触控板平滑

function onWheel(e: WheelEvent) {
  if (!chart) return
  e.preventDefault()
  const histLen = waveform.history[0]?.length ?? 0
  if (histLen === 0) return
  const factor = Math.exp(e.deltaY * ZOOM_STEP)
  const rect = chart.over.getBoundingClientRect()
  const f = rect.width > 0 ? Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) : 0.5
  waveform.zoom(factor, waveform.paused ? f : null)
}

function bindZoom() {
  chart?.over.addEventListener('wheel', onWheel, { passive: false })
}

function unbindZoom() {
  chart?.over.removeEventListener('wheel', onWheel)
}

/** rAF 节流刷入：每帧最多一次 setData，避免 50ms 批次压垮渲染 */
function scheduleSetData() {
  if (rafId != null) return
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number)
  rafId = raf(() => {
    rafId = null
    syncData()
  })
}

function syncData() {
  if (!chart) return
  const el = containerRef.value
  // 隐藏 tab（v-show=false → 0 尺寸）时跳过，切回由 ResizeObserver 兜底
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
  // 通道数变了（设置变更后 store 已清空重建 data）→ 重建图表匹配新 series 数
  if (chart.series.length !== waveform.data.length) {
    rebuild()
    return
  }
  chart.setData(waveform.data as unknown as uPlot.AlignedData)
}

/**
 * 将 uPlot 尺寸同步到当前容器。
 * 面板挂载于 dockview 隐藏容器（visibility:hidden，尺寸非 0）时，rebuild 按挂载瞬间
 * 的旧尺寸建图；dockview 随后把容器收敛到最终尺寸时 RO 虽触发、却被 visibility 守卫
 * 跳过，且切到该面板只改 visibility 不改尺寸（RO 不再触发）——激活时必须强制对一次。
 * 同尺寸 setSize 是幂等 no-op，不会触发反馈环。
 */
function resizeToContainer() {
  const el = containerRef.value
  if (!chart || !el) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (w === 0 || h === 0) return
  lastW = w
  lastH = h
  chart.setSize({ width: w, height: h })
  syncData()
}

// 数据变化 → rAF 节流刷入。watch 版本号而非数组长度：窗口滚满后长度恒定，
// 长度信号会失效导致图表停止刷新；version 每次 ingest 自增，保证持续触发。
watch(
  () => waveform.version,
  () => scheduleSetData(),
  { flush: 'post' }
)

// 主题切换 → 销毁重建（应用新配色；低频，重建成本可忽略）
watch(isDark, () => rebuild())

// 暂停状态切换 → 更新覆盖层光标（grab / 默认）；拖拽中不打断。
// 暂停已统一为应用级（messages 与 waveform 共享），暂停/恢复的缺失数据提示由
// MessageList 统一发出，这里只管本视图的光标，避免与消息侧重复弹 toast。
watch(() => waveform.paused, (p) => {
  if (chart && !panActive) chart.over.style.cursor = p ? 'grab' : ''
})

// 断点标记变化 → 重绘（新断点出现 or 清空擦除）
watch(
  () => waveform.resumeBreakX,
  () => { if (chart) chart.redraw() }
)

// 通道数变更 → 同步可见性数组长度；若 chart.series 数量不匹配则重建
watch(
  () => waveform.channelCount,
  () => {
    syncChannelVisibility()
    if (chart) {
      const expectedSeries = channels() + 1 // X + N channels
      if (chart.series.length !== expectedSeries) rebuild()
    }
  }
)

// 动态通道标签变更（文本模式新标签出现）→ 同步可见性
watch(
  () => waveform.textLabels.length,
  () => {
    syncChannelVisibility()
  }
)

onMounted(() => {
  rebuild()
  const el = containerRef.value
  if (!el) return
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.floor(e.contentRect.width)
      const h = Math.floor(e.contentRect.height)
      // 0 尺寸（隐藏 tab）跳过；切回时此处自动触发 setSize + 补一次 setData
      if (w === 0 || h === 0) return
      // dockview 隐藏面板（renderContainer）用 visibility:hidden 而非 display:none，
      // 宽度非 0 且容器高度会随 uPlot 内容增长——必须跳过，否则 setSize 反复触发尺寸
      // 变化形成反馈环；激活时的强制 resize 由下方 onDidActiveChange 订阅补上
      if (getComputedStyle(e.target as HTMLElement).visibility === 'hidden') return
      resizeToContainer()
    }
  })
  ro.observe(el)
  // 面板激活（dockview 切 tab/拖拽均触发）：visibility 变化不改尺寸、RO 不触发，
  // 需主动对一次容器尺寸（覆盖「挂载于隐藏面板时按旧尺寸建图」的残留状态）
  apiSub = props.params?.api?.onDidActiveChange?.((e) => {
    if (e.isActive) {
      // 等当前帧 DOM（visibility/布局）落定后再读容器尺寸
      requestAnimationFrame(resizeToContainer)
    }
  }) ?? null
})

onBeforeUnmount(() => {
  apiSub?.dispose()
  apiSub = null
  if (rafId != null) cancelAnimationFrame(rafId)
  rafId = null
  ro?.disconnect()
  ro = null
  destroyChart()
})

// 历史缓冲裁剪丢弃采样标签：累计丢弃出现（0→正数）时显示，可手动关闭，清空后新一轮丢弃重新出现
const droppedTagDismissed = ref(false)
const showDroppedTag = computed(() => waveform.droppedSamples > 0 && !droppedTagDismissed.value)
watch(
  () => waveform.droppedSamples,
  (n, prev) => {
    if (prev === 0 && n > 0) droppedTagDismissed.value = false
  }
)

const pointCount = computed(() => {
  // data 是 shallowRef 且原地修改（push/slice 不替换 .value），length 变化不触发响应式。
  // 借 version 作更新信号：每次 ingest / 配置变更都自增，驱动此处重算。
  void waveform.version
  return waveform.data[0]?.length ?? 0
})

// 回看偏移折算为秒（可视窗口右边缘距最新采样的真实时间差），用于工具栏提示
const backSeconds = computed(() => {
  // history 是 shallowRef 且原地 push（不触发响应式），借 version 作更新信号（同 pointCount）
  void waveform.version
  const hist = waveform.history[0]
  const histLen = hist?.length ?? 0
  if (histLen === 0 || waveform.viewOffset === 0) return 0
  // 可视窗口右边缘 = 末尾前移 viewOffset 个采样；与最新采样（末尾）的时间差即回看时长
  const rightEdgeIdx = histLen - 1 - waveform.viewOffset
  if (rightEdgeIdx < 0) return 0
  return (hist[histLen - 1] - hist[rightEdgeIdx]) / 1000
})

// 缩放倍率 = maxPoints / viewSize（放大后 >1），用于工具栏提示
const zoomLevel = computed(() => {
  const mp = settings.waveform.maxPoints
  return mp / Math.max(1, waveform.viewSize)
})

// —— 导出下拉菜单 ——
const exportOptions = computed<DropdownOption[]>(() => [
  { label: t('waveform.exportCsvVisible'), key: 'csv-visible' },
  { label: t('waveform.exportCsvFull'), key: 'csv-full' },
])

function generateExportFilename(ext: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `waveform-${stamp}.${ext}`
}

function handleExport(key: string) {
  const scope = key === 'csv-visible' ? 'visible' : 'full'
  const sourceData = scope === 'visible' ? waveform.data : waveform.history
  const content = exportWaveformAsCsv(sourceData, channelVisible.value, waveform.textLabels)
  downloadTextFile(generateExportFilename('csv'), content)
}
</script>

<template>
  <div class="wave-wrap">
    <div class="toolbar">
      <NTooltip>
        <template #trigger>
          <NTag size="small" :bordered="false">{{ t('waveform.points', { n: pointCount }) }}</NTag>
        </template>
        {{ t('waveform.pointsTip') }}
      </NTooltip>
      <NTag
        v-if="showDroppedTag"
        size="small"
        closable
        type="warning"
        :bordered="false"
        @close="droppedTagDismissed = true"
      >
        {{ t('waveform.droppedSamples', { n: waveform.droppedSamples }) }}
      </NTag>
      <NButton
        v-for="i in channels()"
        :key="i"
        size="tiny"
        :secondary="!channelVisible[i - 1]"
        :style="channelVisible[i - 1] ? {
          borderColor: channelColor(i - 1, channels()),
          color: channelColor(i - 1, channels()),
        } : {}"
        @click="toggleChannel(i - 1)"
      >
        <span class="ch-dot" :style="{
          background: channelVisible[i - 1] ? channelColor(i - 1, channels()) : '#888'
        }" />
        {{ channelLabel(i - 1) }}
      </NButton>
      <NTag v-if="waveform.paused" size="small" :bordered="false" type="info">{{ t('waveform.dragHistory') }}</NTag>
      <NTag v-if="waveform.viewOffset > 0" size="small" :bordered="false" type="warning">
        {{ t('waveform.backSeconds', { s: backSeconds.toFixed(1) }) }}
      </NTag>
      <NTag v-if="waveform.zoomed" size="small" :bordered="false" type="success">
        {{ t('waveform.zoomLevel', { x: zoomLevel.toFixed(1) }) }}
      </NTag>
      <div class="spacer" />
      <NButton v-if="waveform.zoomed" size="tiny" @click="waveform.resetZoom()">{{ t('waveform.resetZoom') }}</NButton>
      <NButton v-if="waveform.viewOffset > 0" size="tiny" @click="waveform.resetView()">
        {{ t('waveform.backToLatest') }}
      </NButton>
      <NButton
        size="tiny"
        :type="waveform.paused ? 'warning' : 'default'"
        @click="waveform.togglePause()"
      >
        {{ waveform.paused ? t('waveform.paused') : t('waveform.pause') }}
      </NButton>
      <NButton size="tiny" @click="pauseStore.clearAll()">{{ t('waveform.clear') }}</NButton>
      <NDropdown trigger="click" :options="exportOptions" @select="handleExport">
        <NButton size="tiny">{{ t('waveform.export') }}</NButton>
      </NDropdown>
    </div>
    <div ref="containerRef" class="chart-area">
      <div
        v-show="tooltipVisible"
        ref="tooltipRef"
        class="cursor-tooltip"
        :class="{ below: tooltipBelow }"
        :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }"
      >
        <div class="tooltip-time">{{ tooltipTime }}</div>
        <div v-for="v in tooltipValues" :key="v.label" class="tooltip-ch">
          <span class="tooltip-dot" :style="{ background: v.color }" />
          <span>{{ v.label }}: {{ v.value }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wave-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  /* dockview 下父容器（.dv-vue-part）是 block 非 flex，flex:1 不生效，须显式定高，
     否则高度退化为 uPlot 内容自适应，canvas 与容器相互撑高形成增长反馈环 */
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
}
.spacer {
  flex: 1;
}
.chart-area {
  flex: 1;
  min-height: 0;
  background: var(--bg-panel);
  position: relative;
}
.chart-area :deep(.uplot-wrap) {
  font-family: var(--mono-font);
}
.chart-area :deep(.u-legend) {
  font-size: 11px;
}
.cursor-tooltip {
  position: absolute;
  pointer-events: none;
  z-index: 10;
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  border-radius: 6px;
  padding: 6px 10px;
  font-family: var(--mono-font);
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
  transform: translate(-50%, -100%);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.cursor-tooltip.below {
  transform: translate(-50%, 0);
}
.tooltip-time {
  opacity: 0.7;
  font-size: 11px;
  margin-bottom: 2px;
}
.tooltip-ch {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tooltip-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: var(--pill-radius);
  flex-shrink: 0;
}
.ch-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: var(--pill-radius);
  margin-right: 4px;
  flex-shrink: 0;
}
</style>
