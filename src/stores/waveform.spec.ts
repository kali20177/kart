import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useWaveformStore } from './waveform'
import { useSettingsStore } from './settings'
import { waveformTextChunk, waveformTextLabeledChunk } from '@/mock/scenarios'

const enc = (s: string) => new TextEncoder().encode(s)

// 端到端验证 ingest → 文本行解析 → 滑动窗口 的数据流（不依赖 uPlot / canvas）
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('waveform store ingest（文本行解析）', () => {
  it('单行 "1,2" → 1 采样点 × 2 通道', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(1) // X
    expect(wf.data[1]).toEqual([1]) // CH1
    expect(wf.data[2]).toEqual([2]) // CH2
  })

  it('多行连续采样，X 单调递增', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('10\n20\n30\n'))
    expect(wf.data[1]).toEqual([10, 20, 30])
    expect(wf.data[0][2]).toBeGreaterThan(wf.data[0][0])
  })

  it('跨回调 carryover：半截行拼到下批', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('12.'))
    expect(wf.data[0].length).toBe(0) // 半截行不成点
    wf.ingest(enc('5\n'))
    expect(wf.data[0].length).toBe(1)
    expect(wf.data[1]).toEqual([12.5])
  })

  it('暂停时不摄入数据', () => {
    const wf = useWaveformStore()
    wf.togglePause()
    expect(wf.paused).toBe(true)
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(0)
    wf.togglePause()
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(1)
  })

  it('清空重置缓冲、计数器与通道数', async () => {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 5
    await nextTick()
    const wf = useWaveformStore()
    wf.ingest(enc('1,2,3\n')) // 3 通道
    expect(wf.data[0].length).toBe(1)
    expect(wf.channelCount).toBe(3)
    wf.clear()
    expect(wf.data[0].length).toBe(0)
    expect(wf.channelCount).toBe(1) // 通道数一并归 1，不残留旧通道
    // 清空后重新开始
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(1)
  })

  it('回归：窗口滚满后 version 仍持续递增（图表刷新信号不能依赖长度）', async () => {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 5
    await nextTick()
    const wf = useWaveformStore()
    for (let i = 0; i < 5; i++) wf.ingest(enc(`${i}\n`))
    expect(wf.data[0].length).toBe(5) // 滚满 → 长度恒定
    const v0 = wf.version
    wf.ingest(enc('99\n'))
    expect(wf.data[0].length).toBe(5) // 长度不变
    expect(wf.version).toBeGreaterThan(v0) // 但版本号仍递增 → 图表仍会刷新
    const v1 = wf.version
    wf.ingest(enc('100\n'))
    expect(wf.version).toBeGreaterThan(v1)
  })

  it('mock 场景 waveformTextChunk 可解析', () => {
    const wf = useWaveformStore()
    wf.ingest(waveformTextChunk(0))
    wf.ingest(waveformTextChunk(1))
    expect(wf.data[0].length).toBe(2) // 两行 -> 两采样点
    expect(wf.data[1].length).toBe(2)
    expect(wf.data[2].length).toBe(2)
    // analogRead 量程 0~1024
    for (const v of wf.data[1]) expect(v).toBeGreaterThanOrEqual(-4)
    for (const v of wf.data[1]) expect(v).toBeLessThanOrEqual(1028)
  })

  it('X 用真实到达时间（与消息时间戳对齐）', () => {
    vi.useFakeTimers()
    const wf = useWaveformStore()

    vi.setSystemTime(1000)
    wf.ingest(enc('1\n'))
    expect(wf.data[0][0]).toBe(1000)

    // 1 秒后第二个采样：真实时间应为 2000
    vi.setSystemTime(2000)
    wf.ingest(enc('2\n'))
    expect(wf.data[0][1]).toBe(2000)

    vi.useRealTimers()
  })

  it('解析配置变更（parse 对象引用变更）→ 清空重建', async () => {
    const wf = useWaveformStore()
    wf.ingest(enc('1,2\n'))
    expect(wf.data[0].length).toBe(1)
    const settings = useSettingsStore()
    // 替换整个 parse 对象触发 deep watch → clear
    settings.settings.waveform.parse = {}
    await nextTick()
    expect(wf.data[0].length).toBe(0) // 已清空
  })
})

describe('waveform store 历史回看', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // 灌多行文本采样，使 history 有足够数据回看
  async function seedHistory(count: number) {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 5
    await nextTick()
    const wf = useWaveformStore()
    for (let i = 0; i < count; i++) {
      wf.ingest(enc(`${i}\n`))
    }
    return wf
  }

  it('暂停后 setViewOffset 回看更早采样（X 时间戳更小）', async () => {
    const wf = await seedHistory(20)
    expect(wf.history[0].length).toBe(20)
    const latestFirstX = wf.data[0][0] // viewOffset=0 → 末尾窗口里最早点的 X
    wf.togglePause()
    wf.setViewOffset(15) // 回看
    expect(wf.viewOffset).toBe(15)
    expect(wf.data[0].length).toBe(5)
    const backFirstX = wf.data[0][0]
    expect(backFirstX).toBeLessThan(latestFirstX)
  })

  it('setViewOffset 越界 clamp：不小于 0、不超过 history-viewSize', async () => {
    const wf = await seedHistory(20)
    wf.togglePause()
    wf.setViewOffset(-100)
    expect(wf.viewOffset).toBe(0)
    wf.setViewOffset(99999)
    expect(wf.viewOffset).toBe(15) // 20 - 5
  })

  it('恢复（togglePause）自动回到最新', async () => {
    const wf = await seedHistory(20)
    wf.togglePause()
    wf.setViewOffset(15)
    expect(wf.viewOffset).toBe(15)
    wf.togglePause() // 恢复
    expect(wf.viewOffset).toBe(0)
    expect(wf.data[0][0]).toBe(wf.history[0][15]) // 回到末尾窗口
  })

  it('resetView 回到最新', async () => {
    const wf = await seedHistory(20)
    wf.togglePause()
    wf.setViewOffset(10)
    expect(wf.viewOffset).toBe(10)
    wf.resetView()
    expect(wf.viewOffset).toBe(0)
  })

  it('运行中（未暂停）ingest 始终跟随最新，viewOffset 恒为 0', async () => {
    const wf = await seedHistory(20)
    expect(wf.viewOffset).toBe(0)
    wf.ingest(enc('99\n'))
    expect(wf.viewOffset).toBe(0) // 运行中不会停留在历史
    expect(wf.data[0][4]).toBe(wf.history[0][20]) // 末尾窗口里最后一点 = 最新采样
  })
})

describe('waveform store 滚轮缩放', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function seedHistory(count: number) {
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 10
    await nextTick()
    const wf = useWaveformStore()
    for (let i = 0; i < count; i++) {
      wf.ingest(enc(`${i}\n`))
    }
    return wf
  }

  it('运行中缩放（锚定最新）：viewSize 减小、viewOffset 恒 0', async () => {
    const wf = await seedHistory(64) // history=64, viewSize=10
    expect(wf.zoomed).toBe(false)
    wf.zoom(0.5, null) // 运行中 → 锚定最新
    expect(wf.viewSize).toBe(5)
    expect(wf.zoomed).toBe(true)
    expect(wf.viewOffset).toBe(0)
    expect(wf.data[0].length).toBe(5)
    expect(wf.data[0][0]).toBe(wf.history[0][59]) // 末尾 5 点
    expect(wf.data[0][4]).toBe(wf.history[0][63])
  })

  it('运行中缩放后 ingest 仍跟随最新', async () => {
    const wf = await seedHistory(64)
    wf.zoom(0.5, null) // viewSize=5
    wf.ingest(enc('99\n')) // +1 → history=65
    expect(wf.viewOffset).toBe(0)
    expect(wf.viewSize).toBe(5)
    expect(wf.data[0].length).toBe(5)
    expect(wf.data[0][4]).toBe(wf.history[0][64]) // 末尾采样
  })

  it('暂停时光标锚定（f=0.5）：锚点采样留在新窗口内', async () => {
    const wf = await seedHistory(64)
    wf.togglePause()
    // 暂停时 viewOffset=0 → 末尾窗口 sample 54..63；光标中心 f=0.5 → 锚点 sample 59
    const anchorX = wf.history[0][59]
    wf.zoom(0.5, 0.5) // viewSize 10→5，光标锚定
    expect(wf.viewSize).toBe(5)
    expect(wf.viewOffset).toBe(3)
    expect(wf.data[0]).toContain(anchorX)
  })

  it('缩小至 maxPoints → zoomed 归 false', async () => {
    const wf = await seedHistory(64)
    wf.zoom(0.5, null) // viewSize 10→5
    expect(wf.zoomed).toBe(true)
    wf.zoom(3, null) // 5×3=15 → clamp 至 maxPoints=10
    expect(wf.viewSize).toBe(10)
    expect(wf.zoomed).toBe(false)
  })

  it('放大撞 MIN_VIEW 不再变小', async () => {
    const wf = await seedHistory(64)
    wf.zoom(0.001, null) // 10×0.001→0 → clamp MIN_VIEW=2
    expect(wf.viewSize).toBe(2)
    wf.zoom(0.001, null) // 2×0.001→0 → clamp 2
    expect(wf.viewSize).toBe(2)
  })

  it('resetZoom 回到默认窗口', async () => {
    const wf = await seedHistory(64)
    wf.zoom(0.5, null)
    expect(wf.zoomed).toBe(true)
    wf.resetZoom()
    expect(wf.viewSize).toBe(10)
    expect(wf.zoomed).toBe(false)
  })

  it('未缩放时改 maxPoints → viewSize 跟随', async () => {
    const wf = await seedHistory(64) // maxPoints=10, viewSize=10, !zoomed
    expect(wf.viewSize).toBe(10)
    expect(wf.zoomed).toBe(false)
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 20
    await nextTick()
    expect(wf.viewSize).toBe(20)
    expect(wf.zoomed).toBe(false)
  })

  it('缩放中改 maxPoints → 保持 viewSize 仅 clamp', async () => {
    const wf = await seedHistory(64) // maxPoints=10
    wf.zoom(0.5, null) // viewSize=5, zoomed
    expect(wf.viewSize).toBe(5)
    const settings = useSettingsStore()
    settings.settings.waveform.maxPoints = 8 // 5 仍在 [2,8] → 保持
    await nextTick()
    expect(wf.viewSize).toBe(5)
    settings.settings.waveform.maxPoints = 3 // 5 > 3 → clamp 至 3
    await nextTick()
    expect(wf.viewSize).toBe(3)
  })

  it('clear 重置缩放', async () => {
    const wf = await seedHistory(64)
    wf.zoom(0.5, null)
    expect(wf.zoomed).toBe(true)
    wf.clear()
    expect(wf.zoomed).toBe(false)
    expect(wf.viewSize).toBe(10)
  })
})

describe('waveform store 标签化文本解析', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('标签化行 -> 自动检测通道名', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('Sin:0.5,Cos:0.86\n'))
    expect(wf.data[1]).toEqual([0.5])
    expect(wf.data[2]).toEqual([0.86])
    expect(wf.textLabels).toEqual(['Sin', 'Cos'])
  })

  it('新标签出现 -> 动态增长通道', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('A:1\n'))
    expect(wf.textLabels.length).toBe(1)
    expect(wf.textLabels[0]).toBe('A')
    wf.ingest(enc('B:2\n'))
    expect(wf.textLabels.length).toBe(2)
    expect(wf.textLabels[1]).toBe('B')
    expect(wf.history.length).toBe(3) // X + 2ch
  })

  it('标签化 mock 场景 waveformTextLabeledChunk 可解析', () => {
    const wf = useWaveformStore()
    wf.ingest(waveformTextLabeledChunk(0))
    wf.ingest(waveformTextLabeledChunk(1))
    expect(wf.data[0].length).toBe(2)
    expect(wf.data[1].length).toBe(2)
    expect(wf.data[2].length).toBe(2)
    // 6 个通道标签：Temp, Hum, Pres, Alt, Bat, RSSI
    expect(wf.textLabels).toEqual(['Temp', 'Hum', 'Pres', 'Alt', 'Bat', 'RSSI'])
    expect(wf.history.length).toBe(7)
    // 通道值在合理范围内
    expect(wf.history[1][0]).toBeGreaterThan(20)  // Temp ~25
    expect(wf.history[1][0]).toBeLessThan(30)
    expect(wf.history[5][0]).toBeGreaterThan(0)   // Bat ~3.7
    expect(wf.history[5][0]).toBeLessThan(5)
    expect(wf.history[6][0]).toBeLessThan(-50)    // RSSI 负值
  })

  it('clear 重置标签', () => {
    const wf = useWaveformStore()
    wf.ingest(enc('Sin:0.5,Cos:0.86\n'))
    expect(wf.textLabels.length).toBe(2)
    wf.clear()
    expect(wf.textLabels).toEqual([])
    expect(wf.data[0].length).toBe(0)
  })
})
