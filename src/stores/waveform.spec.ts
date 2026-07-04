import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useWaveformStore } from './waveform'
import { useSettingsStore } from './settings'
import { waveformChunk } from '@/mock/scenarios'

// 端到端验证 ingest → 解析 → 滑动窗口 的数据流（不依赖 uPlot / canvas）
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('waveform store ingest', () => {
  it('一帧 128 字节 → 32 采样 × 2 通道', () => {
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    expect(wf.data[0].length).toBe(32) // X
    expect(wf.data[1].length).toBe(32) // CH1
    expect(wf.data[2].length).toBe(32) // CH2
    // t=0 时正弦分量为 0，ch0 仅剩 ±400 噪声（慢变包络 env(0)=16000 乘 sin(0)=0）
    expect(Math.abs(wf.data[1][0])).toBeLessThanOrEqual(400)
  })

  it('两帧连续采样，X 单调递增、计数连续', () => {
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    wf.ingest(waveformChunk(1))
    expect(wf.data[0].length).toBe(64)
    const x0 = wf.data[0][0]
    const xLast = wf.data[0][63]
    expect(xLast).toBeGreaterThan(x0)
    // 默认 640Hz → 每采样 1000/640 ms，64 采样 ≈ 100ms
    expect(xLast - x0).toBeCloseTo((63 * 1000) / 640, 1)
  })

  it('跨回调 carryover：半个 record 拼到下批', () => {
    const wf = useWaveformStore()
    const chunk = waveformChunk(0)
    // 切成 3 字节 + 125 字节，3 字节 = 0 完整 record + 3 字节零头（recordSize=4）
    const part1 = chunk.slice(0, 3)
    const part2 = chunk.slice(3)
    wf.ingest(part1)
    expect(wf.data[0].length).toBe(0) // 零头，无完整采样
    wf.ingest(part2)
    expect(wf.data[0].length).toBe(32) // 零头接上后 32 采样齐了
  })

  it('暂停时不摄入数据', () => {
    const wf = useWaveformStore()
    wf.togglePause()
    expect(wf.paused).toBe(true)
    wf.ingest(waveformChunk(0))
    expect(wf.data[0].length).toBe(0)
    wf.togglePause()
    wf.ingest(waveformChunk(0))
    expect(wf.data[0].length).toBe(32)
  })

  it('清空重置缓冲与计数器', () => {
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    expect(wf.data[0].length).toBe(32)
    wf.clear()
    expect(wf.data[0].length).toBe(0)
    // 清空后重新开始，X 从新起点
    wf.ingest(waveformChunk(0))
    expect(wf.data[0].length).toBe(32)
  })

  it('超过 maxPoints 后可视窗口滚满（history 另保留）', async () => {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    // 每帧 32 采样，灌两帧 = 64 点，可视窗口上限 10 → 滚满
    wf.ingest(waveformChunk(0))
    wf.ingest(waveformChunk(1))
    expect(wf.data[0].length).toBe(10) // 可视窗口滚满
    expect(wf.data[1].length).toBe(10)
    expect(wf.history[0].length).toBe(64) // 历史完整保留（不再从头裁剪）
  })

  it('回归：窗口滚满后 version 仍持续递增（图表刷新信号不能依赖长度）', async () => {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0)) // 滚满 → 长度恒为 10
    const v0 = wf.version
    wf.ingest(waveformChunk(1))
    expect(wf.data[0].length).toBe(10) // 长度不变
    expect(wf.version).toBeGreaterThan(v0) // 但版本号仍递增 → 图表仍会刷新
    const v1 = wf.version
    wf.ingest(waveformChunk(2))
    expect(wf.version).toBeGreaterThan(v1)
  })

  it('采样率变更：重算 X 时间戳，不丢点', async () => {
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    // X 是绝对时间戳（startTime + 偏移），应比较相邻点间距，与 startTime 无关
    const spacingBefore = wf.data[0][1] - wf.data[0][0]
    const settings = useSettingsStore()
    settings.settings.waveform.sampleRate = 1280 // 翻倍 → 每采样时间减半
    await nextTick()
    const spacingAfter = wf.data[0][1] - wf.data[0][0]
    expect(spacingAfter).toBeCloseTo(spacingBefore / 2, 2)
    expect(wf.data[0].length).toBe(32) // 点数不变
  })

  it('解析配置变更（通道数）→ 清空重建', async () => {
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    expect(wf.data.length).toBe(3) // X + 2 通道
    const settings = useSettingsStore()
    settings.settings.waveform.parse.channels = 1
    await nextTick()
    expect(wf.data.length).toBe(2) // X + 1 通道
    expect(wf.data[0].length).toBe(0) // 已清空
  })
})

describe('waveform store 历史回看', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // 把可视窗口设小（10），灌 2 帧 = 64 采样 → history=64、maxOffset=54，便于回看
  async function seedSmallWindow() {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    wf.ingest(waveformChunk(1))
    return wf
  }

  it('暂停后 setViewOffset 回看更早采样（X 时间戳更小）', async () => {
    const wf = await seedSmallWindow()
    expect(wf.history[0].length).toBe(64)
    const latestFirstX = wf.data[0][0] // viewOffset=0 → 末尾窗口里最早点（sample 54）的 X
    wf.togglePause() // 暂停后才能回看
    wf.setViewOffset(54) // 回看到最旧（sample 0..9）
    expect(wf.viewOffset).toBe(54)
    expect(wf.data[0].length).toBe(10)
    const backFirstX = wf.data[0][0] // sample 0 的 X
    expect(backFirstX).toBeLessThan(latestFirstX)
  })

  it('setViewOffset 越界 clamp：不小于 0、不超过 history-viewSize', async () => {
    const wf = await seedSmallWindow()
    wf.togglePause()
    wf.setViewOffset(-100)
    expect(wf.viewOffset).toBe(0)
    wf.setViewOffset(99999)
    expect(wf.viewOffset).toBe(54) // 64 - 10
  })

  it('恢复（togglePause）自动回到最新', async () => {
    const wf = await seedSmallWindow()
    wf.togglePause()
    wf.setViewOffset(54)
    expect(wf.viewOffset).toBe(54)
    wf.togglePause() // 恢复
    expect(wf.viewOffset).toBe(0)
    expect(wf.data[0][0]).toBe(wf.history[0][54]) // 回到末尾窗口
  })

  it('resetView 回到最新', async () => {
    const wf = await seedSmallWindow()
    wf.togglePause()
    wf.setViewOffset(40)
    expect(wf.viewOffset).toBe(40)
    wf.resetView()
    expect(wf.viewOffset).toBe(0)
  })

  it('运行中（未暂停）ingest 始终跟随最新，viewOffset 恒为 0', async () => {
    const wf = await seedSmallWindow()
    expect(wf.viewOffset).toBe(0)
    wf.ingest(waveformChunk(2)) // 又一帧，history=96
    expect(wf.viewOffset).toBe(0) // 运行中不会停留在历史
    expect(wf.data[0][0]).toBe(wf.history[0][86]) // 末尾 10 窗口
  })
})

describe('waveform store 滚轮缩放', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // 复用 seedSmallWindow：maxPoints=10、灌 2 帧 = 64 采样、viewSize 默认 = 10
  async function seedSmallWindow() {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    wf.ingest(waveformChunk(0))
    wf.ingest(waveformChunk(1))
    return wf
  }

  it('运行中缩放（锚定最新）：viewSize 减小、viewOffset 恒 0、窗口=末尾 newSize 点', async () => {
    const wf = await seedSmallWindow() // running, viewSize=10, history=64
    expect(wf.zoomed).toBe(false)
    wf.zoom(0.5, null) // 运行中 → anchorFraction=null → 锚定最新
    expect(wf.viewSize).toBe(5)
    expect(wf.zoomed).toBe(true)
    expect(wf.viewOffset).toBe(0)
    expect(wf.data[0].length).toBe(5)
    expect(wf.data[0][0]).toBe(wf.history[0][59]) // 末尾 5 点：sample 59..63
    expect(wf.data[0][4]).toBe(wf.history[0][63])
  })

  it('运行中缩放后 ingest 仍跟随最新（viewSize 不变、viewOffset 恒 0）', async () => {
    const wf = await seedSmallWindow()
    wf.zoom(0.5, null) // viewSize=5
    wf.ingest(waveformChunk(2)) // +32 → history=96
    expect(wf.viewOffset).toBe(0)
    expect(wf.viewSize).toBe(5)
    expect(wf.data[0].length).toBe(5)
    expect(wf.data[0][4]).toBe(wf.history[0][95]) // 末尾采样
  })

  it('暂停时光标锚定（f=0.5）：锚点采样留在新窗口内', async () => {
    const wf = await seedSmallWindow()
    wf.togglePause()
    // 暂停时 viewOffset=0 → 末尾窗口 sample 54..63；光标中心 f=0.5 → 锚点 sample 59
    const anchorX = wf.history[0][59]
    wf.zoom(0.5, 0.5) // viewSize 10→5，光标锚定
    expect(wf.viewSize).toBe(5)
    expect(wf.viewOffset).toBe(3) // 锚定算出的偏移（中心保持）
    expect(wf.data[0]).toContain(anchorX) // 锚点采样仍在可视窗口
  })

  it('暂停时右边缘锚定（f=1）：viewOffset 不变、末尾采样留住', async () => {
    const wf = await seedSmallWindow()
    wf.togglePause()
    wf.setViewOffset(20) // 窗口 sample 34..43，右边缘 = sample 43
    const rightX = wf.history[0][43]
    wf.zoom(0.5, 1.0) // 右边缘锚定
    expect(wf.viewOffset).toBe(20) // 偏移不变
    expect(wf.viewSize).toBe(5)
    expect(wf.data[0][4]).toBe(rightX) // 右边缘采样仍在窗口末尾
  })

  it('缩小至 maxPoints → zoomed 归 false（回到默认窗口）', async () => {
    const wf = await seedSmallWindow()
    wf.zoom(0.5, null) // viewSize 10→5
    expect(wf.zoomed).toBe(true)
    wf.zoom(3, null) // 5×3=15 → clamp 至 maxPoints=10
    expect(wf.viewSize).toBe(10)
    expect(wf.zoomed).toBe(false)
  })

  it('放大撞 MIN_VIEW 不再变小', async () => {
    const wf = await seedSmallWindow()
    wf.zoom(0.001, null) // 10×0.001→0 → clamp MIN_VIEW=2
    expect(wf.viewSize).toBe(2)
    wf.zoom(0.001, null) // 2×0.001→0 → clamp 2，等于 oldSize → 无变化
    expect(wf.viewSize).toBe(2)
  })

  it('resetZoom 回到默认窗口', async () => {
    const wf = await seedSmallWindow()
    wf.zoom(0.5, null)
    expect(wf.zoomed).toBe(true)
    wf.resetZoom()
    expect(wf.viewSize).toBe(10)
    expect(wf.zoomed).toBe(false)
  })

  it('未缩放时改 maxPoints → viewSize 跟随', async () => {
    const wf = await seedSmallWindow() // maxPoints=10, viewSize=10
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 20
    await nextTick()
    expect(wf.viewSize).toBe(20)
    expect(wf.zoomed).toBe(false)
  })

  it('缩放中改 maxPoints → 保持 viewSize 仅 clamp', async () => {
    const wf = await seedSmallWindow() // maxPoints=10
    wf.zoom(0.5, null) // viewSize=5, zoomed
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 8 // 5 仍在 [2,8] → 保持
    await nextTick()
    expect(wf.viewSize).toBe(5)
    settings.settings.waveform.maxPoints = 3 // 5 > 3 → clamp 至 3
    await nextTick()
    expect(wf.viewSize).toBe(3)
  })

  it('clear 重置缩放', async () => {
    const wf = await seedSmallWindow()
    wf.zoom(0.5, null)
    expect(wf.zoomed).toBe(true)
    wf.clear()
    expect(wf.zoomed).toBe(false)
    expect(wf.viewSize).toBe(10)
  })
})
