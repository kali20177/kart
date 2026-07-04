<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { NButton, NTag } from 'naive-ui'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useWaveformStore } from '@/stores/waveform'
import { useSettingsStore } from '@/stores/settings'
import { useIsDark } from '@/composables/useIsDark'

const waveform = useWaveformStore()
const settings = useSettingsStore()
const isDark = useIsDark()

const containerRef = ref<HTMLDivElement | null>(null)

// 通道配色（与主题无关，固定调色板，保证通道可辨识）
const PALETTE = ['#4098fc', '#50c878', '#f0a850', '#ec5b5b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16']

// uPlot 用 export = 导出，默认导入即兼得值与命名空间类型（uPlot.Options / uPlot.Series …）
let chart: uPlot | null = null
let ro: ResizeObserver | null = null
let rafId: number | null = null
let lastW = 0
let lastH = 0

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

function channels(): number {
  return Math.max(1, settings.settings.waveform.parse.channels)
}

function buildOpts(ch: number, w: number, h: number): uPlot.Options {
  const c = themeColors()
  const series: uPlot.Series[] = [
    {}, // X（时间）系列 —— uPlot 约定 index 0
    ...Array.from({ length: ch }, (_, i) => ({
      label: `CH${i + 1}`,
      stroke: PALETTE[i % PALETTE.length],
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
    // 关闭 uPlot 默认拖框放大（drag.setScale）；x/y:false 彻底不画选择框。
    // 暂停时的回看平移由组件自实现（见 onPanDown），不复用 uPlot 的 drag。
    cursor: { points: { show: false }, drag: { setScale: false, x: false, y: false } }
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
  const w = el.clientWidth || lastW || 600
  const h = el.clientHeight || lastH || 300
  lastW = w
  lastH = h
  const opts = buildOpts(channels(), w, h)
  chart = new uPlot(opts, waveform.data as unknown as uPlot.AlignedData, el)
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

// 数据变化 → rAF 节流刷入。watch 版本号而非数组长度：窗口滚满后长度恒定，
// 长度信号会失效导致图表停止刷新；version 每次 ingest 自增，保证持续触发。
watch(
  () => waveform.version,
  () => scheduleSetData(),
  { flush: 'post' }
)

// 主题切换 → 销毁重建（应用新配色；低频，重建成本可忽略）
watch(isDark, () => rebuild())

// 暂停状态切换 → 更新覆盖层光标（grab / 默认）；拖拽中不打断
watch(
  () => waveform.paused,
  (p) => {
    if (chart && !panActive) chart.over.style.cursor = p ? 'grab' : ''
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
      if (chart && (w !== lastW || h !== lastH)) {
        lastW = w
        lastH = h
        chart.setSize({ width: w, height: h })
        syncData()
      }
    }
  })
  ro.observe(el)
})

onBeforeUnmount(() => {
  if (rafId != null) cancelAnimationFrame(rafId)
  rafId = null
  ro?.disconnect()
  ro = null
  destroyChart()
})

const pointCount = computed(() => {
  // data 是 shallowRef 且原地修改（push/slice 不替换 .value），length 变化不触发响应式。
  // 借 version 作更新信号：每次 ingest / 配置变更都自增，驱动此处重算。
  void waveform.version
  return waveform.data[0]?.length ?? 0
})

// 回看偏移折算为秒（viewOffset 采样 / 采样率），用于工具栏提示
const backSeconds = computed(() => {
  const rate = Math.max(1, settings.settings.waveform.sampleRate)
  return waveform.viewOffset / rate
})

// 缩放倍率 = maxPoints / viewSize（放大后 >1），用于工具栏提示
const zoomLevel = computed(() => {
  const mp = settings.settings.waveform.maxPoints
  return mp / Math.max(1, waveform.viewSize)
})
</script>

<template>
  <div class="wave-wrap">
    <div class="toolbar">
      <NTag size="small" :bordered="false">{{ pointCount }} 点</NTag>
      <NTag size="small" :bordered="false">{{ channels() }} 通道</NTag>
      <NTag v-if="waveform.paused" size="small" :bordered="false" type="info">拖拽回看历史</NTag>
      <NTag v-if="waveform.viewOffset > 0" size="small" :bordered="false" type="warning">
        回看 −{{ backSeconds.toFixed(1) }}s
      </NTag>
      <NTag v-if="waveform.zoomed" size="small" :bordered="false" type="success">
        放大 ×{{ zoomLevel.toFixed(1) }}
      </NTag>
      <div class="spacer" />
      <NButton v-if="waveform.zoomed" size="tiny" @click="waveform.resetZoom()">重置缩放</NButton>
      <NButton v-if="waveform.viewOffset > 0" size="tiny" @click="waveform.resetView()">
        回到最新
      </NButton>
      <NButton
        size="tiny"
        :type="waveform.paused ? 'warning' : 'default'"
        @click="waveform.togglePause()"
      >
        {{ waveform.paused ? '已暂停' : '暂停' }}
      </NButton>
      <NButton size="tiny" @click="waveform.clear()">清空</NButton>
    </div>
    <div ref="containerRef" class="chart-area" />
  </div>
</template>

<style scoped>
.wave-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.spacer {
  flex: 1;
}
.chart-area {
  flex: 1;
  min-height: 0;
  background: var(--bg-panel);
}
.chart-area :deep(.uplot-wrap) {
  font-family: var(--mono-font);
}
.chart-area :deep(.u-legend) {
  font-size: 11px;
}
</style>
