import { describe, it, expect } from 'vitest'
import {
  isValidBaud,
  isPresetBaud,
  loadCustomBaudRates,
  PRESET_BAUDS,
  BAUD_MIN,
  BAUD_MAX
} from './baud'

describe('isValidBaud', () => {
  it('接受范围内的正整数', () => {
    expect(isValidBaud(9600)).toBe(true)
    expect(isValidBaud(BAUD_MIN)).toBe(true)
    expect(isValidBaud(BAUD_MAX)).toBe(true)
  })
  it('拒绝零、负数、小数、越界与 NaN', () => {
    expect(isValidBaud(0)).toBe(false)
    expect(isValidBaud(-1)).toBe(false)
    expect(isValidBaud(1.5)).toBe(false)
    expect(isValidBaud(BAUD_MAX + 1)).toBe(false)
    expect(isValidBaud(Number.NaN)).toBe(false)
  })
})

describe('isPresetBaud', () => {
  it('识别预设档位', () => {
    expect(isPresetBaud(115200)).toBe(true)
    expect(isPresetBaud(74880)).toBe(true)
  })
  it('非预设档位返回 false', () => {
    expect(isPresetBaud(500000)).toBe(false)
  })
  it('PRESET_BAUDS 每一项都被识别为预设', () => {
    for (const b of PRESET_BAUDS) expect(isPresetBaud(b)).toBe(true)
  })
})

describe('loadCustomBaudRates', () => {
  it('空数组返回空', () => {
    expect(loadCustomBaudRates([])).toEqual([])
  })
  it('非数组返回空', () => {
    expect(loadCustomBaudRates(null)).toEqual([])
    expect(loadCustomBaudRates('x')).toEqual([])
  })
  it('兼容旧 number[] 格式，转为带 baud 的对象数组', () => {
    expect(loadCustomBaudRates([74880, 500000])).toEqual([
      { baud: 74880 },
      { baud: 500000 }
    ])
  })
  it('新版 CustomBaudRate[] 原样返回（含标注）', () => {
    const data = [{ baud: 500000, note: '自定义设备' }]
    expect(loadCustomBaudRates(data)).toEqual(data)
  })
})
