import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSerialStore } from './serial'

const KEY = 'serial-demo:customBaudRates'

beforeEach(() => {
  setActivePinia(createPinia())
  // localStorage 由 src/test/setup.ts 统一提供（内存版，每用例重置）
})

describe('serial store · 自定义波特率', () => {
  it('预设档位与已存在项不会被重复加入，结果升序持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.addCustomBaudRate(300000)
    s.addCustomBaudRate(74880) // 预设，应忽略
    s.addCustomBaudRate(500000) // 已存在，应忽略
    expect(s.customBaudRates.map((c) => c.baud)).toEqual([300000, 500000])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      { baud: 300000 },
      { baud: 500000 }
    ])
  })

  it('删除自定义波特率并持久化', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.removeCustomBaudRate(500000)
    expect(s.customBaudRates).toEqual([])
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('更新标注，空串/空白清除标注', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(500000)
    s.updateCustomBaudNote(500000, '我的设备')
    expect(s.customBaudRates[0].note).toBe('我的设备')
    s.updateCustomBaudNote(500000, '   ')
    expect(s.customBaudRates[0].note).toBeUndefined()
  })

  it('加载时兼容旧版 number[] 格式', () => {
    localStorage.setItem(KEY, JSON.stringify([74880, 500000]))
    const s = useSerialStore()
    expect(s.customBaudRates).toEqual([{ baud: 74880 }, { baud: 500000 }])
  })

  it('非法 baud（0/负/小数/越界）不会被加入', () => {
    const s = useSerialStore()
    s.addCustomBaudRate(0)
    s.addCustomBaudRate(-1)
    s.addCustomBaudRate(1.5)
    s.addCustomBaudRate(99_999_999)
    expect(s.customBaudRates).toEqual([])
  })
})

describe('serial store · reset', () => {
  const PORT_KEY = 'serial-demo:portOptions'

  it('恢复端口参数与自定义波特率默认值并落盘', () => {
    const s = useSerialStore()
    // 污染：改端口参数 + 加自定义波特率
    s.options.baudRate = 9600
    s.options.parity = 'even'
    s.addCustomBaudRate(500000)
    expect(s.customBaudRates.length).toBe(1)

    s.reset()

    // 内存：端口参数回默认
    expect(s.options).toEqual({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    })
    // 内存：自定义波特率清空
    expect(s.customBaudRates).toEqual([])
    // 落盘
    expect(JSON.parse(localStorage.getItem(PORT_KEY)!)).toEqual({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    })
    expect(localStorage.getItem(KEY)).toBe('[]')
  })
})
