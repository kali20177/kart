import { describe, it, expect } from 'vitest'
import { exportWaveformAsCsv, type WaveformExportMeta } from './export-waveform-csv'

function makeMeta(overrides?: Partial<WaveformExportMeta>): WaveformExportMeta {
  return {
    sampleRate: 640,
    numericType: 'int16',
    channels: 2,
    littleEndian: true,
    scope: 'visible',
    exportedAt: 1700000000000,
    ...overrides
  }
}

/** 构建测试数据：[X, ch1, ch2, ...] */
function makeData(xs: number[], ...channels: number[][]): number[][] {
  return [xs, ...channels]
}

describe('exportWaveformAsCsv', () => {
  it('emits BOM + header + one row per sample', () => {
    const data = makeData(
      [1000, 1001, 1002],
      [10, 20, 30],
      [100, 200, 300]
    )
    const csv = exportWaveformAsCsv(data, [true, true], makeMeta())
    expect(csv.startsWith('﻿')).toBe(true)
    // BOM + header + 3 data rows + trailing newline
    const lines = csv.split('\n')
    expect(lines.length).toBe(5)
    expect(lines[0]).toBe('﻿time_sec,CH1,CH2')
    expect(lines[1]).toBe('0.000,10,100')
    expect(lines[2]).toBe('0.001,20,200')
    expect(lines[3]).toBe('0.002,30,300')
  })

  it('respects channel visibility', () => {
    // 3 channels, only CH1 and CH3 visible
    const data = makeData(
      [1000, 1001],
      [10, 20],
      [100, 200],
      [1000, 2000]
    )
    const csv = exportWaveformAsCsv(data, [true, false, true], makeMeta({ channels: 3 }))
    const lines = csv.split('\n').filter(Boolean)
    expect(lines[0]).toBe('﻿time_sec,CH1,CH3')
    expect(lines[1]).toBe('0.000,10,1000')
    expect(lines[2]).toBe('0.001,20,2000')
  })

  it('all channels hidden yields only time column', () => {
    const data = makeData([1000, 1001], [10, 20])
    const csv = exportWaveformAsCsv(data, [false, false], makeMeta())
    const lines = csv.split('\n').filter(Boolean)
    expect(lines[0]).toBe('﻿time_sec')
    expect(lines[1]).toBe('0.000')
    expect(lines[2]).toBe('0.001')
  })

  it('empty data returns BOM + header only', () => {
    const data = makeData([], [])
    const csv = exportWaveformAsCsv(data, [true, true], makeMeta())
    const lines = csv.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect(lines[0]).toBe('﻿time_sec,CH1,CH2')
  })

  it('single channel export', () => {
    const data = makeData([1000, 1001], [42, 99])
    const csv = exportWaveformAsCsv(data, [true], makeMeta({ channels: 1 }))
    const lines = csv.split('\n').filter(Boolean)
    expect(lines[0]).toBe('﻿time_sec,CH1')
    expect(lines[1]).toBe('0.000,42')
    expect(lines[2]).toBe('0.001,99')
  })

  it('handles float values', () => {
    const data = makeData([1000.5, 1001.25], [3.14159, -0.00123])
    const csv = exportWaveformAsCsv(data, [true], makeMeta({ channels: 1, numericType: 'float32' }))
    const lines = csv.split('\n').filter(Boolean)
    expect(lines[0]).toBe('﻿time_sec,CH1')
    expect(lines[1]).toBe('0.000,3.14159')
    // (1001.25 - 1000.5) / 1000 = 0.00075 → toFixed(3) = 0.001
    expect(lines[2]).toBe('0.001,-0.00123')
  })

  it('handles integer values without decimal point', () => {
    const data = makeData([0, 1000], [32767, -32768])
    const csv = exportWaveformAsCsv(data, [true], makeMeta({ channels: 1 }))
    const lines = csv.split('\n').filter(Boolean)
    expect(lines[1]).toBe('0.000,32767')
    expect(lines[2]).toBe('1.000,-32768')
  })

  it('large dataset', () => {
    const n = 1000
    const xs = Array.from({ length: n }, (_, i) => i)
    const ch1 = Array.from({ length: n }, (_, i) => i * 2)
    const data = makeData(xs, ch1)
    const csv = exportWaveformAsCsv(data, [true], makeMeta({ channels: 1 }))
    const lines = csv.split('\n').filter(Boolean)
    expect(lines.length).toBe(n + 1) // header + 1000 data rows
    expect(lines[0]).toBe('﻿time_sec,CH1')
    expect(lines[1]).toBe('0.000,0')
    expect(lines[lines.length - 1]).toBe('0.999,1998')
  })
})