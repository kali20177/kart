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

  it('超过 maxPoints 从头裁剪（滚动窗口）', async () => {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    // 每帧 32 采样，灌两帧 = 64 点，上限 10 → 裁到 10
    wf.ingest(waveformChunk(0))
    wf.ingest(waveformChunk(1))
    expect(wf.data[0].length).toBe(10)
    expect(wf.data[1].length).toBe(10)
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
