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
    cursor: { points: { show: false } }
  }
}

function destroyChart() {
  if (chart) {
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
</script>

<template>
  <div class="wave-wrap">
    <div class="toolbar">
      <NTag size="small" :bordered="false">{{ pointCount }} 点</NTag>
      <NTag size="small" :bordered="false">{{ channels() }} 通道</NTag>
      <div class="spacer" />
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
