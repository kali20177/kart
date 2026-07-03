import type { CustomBaudRate } from '@/types'

/** 预设波特率：常用标准档 + 工程上常见的非标准档（ESP8266 复位、MIDI、Marlin） */
export const PRESET_BAUDS = [
  1200, 2400, 4800, 9600, 19200, 31250, 38400, 57600, 74880, 115200,
  230400, 250000, 460800, 921600, 1000000, 2000000
]

const PRESET_BAUDS_SET = new Set(PRESET_BAUDS)

/** 预设档位的来源标注（不可由用户修改） */
export const BAUD_NOTES: Record<number, string> = {
  31250: 'MIDI',
  74880: 'ESP8266 复位',
  250000: 'Marlin / 3D 打印'
}

export const BAUD_MIN = 1
export const BAUD_MAX = 10_000_000

/** 判断是否为预设档位（预设不可由用户删除） */
export function isPresetBaud(baud: number): boolean {
  return PRESET_BAUDS_SET.has(baud)
}

/** 校验波特率是否为合法正整数且在允许范围内 */
export function isValidBaud(n: number): boolean {
  return Number.isInteger(n) && n >= BAUD_MIN && n <= BAUD_MAX
}

/**
 * 读取持久化的自定义波特率，兼容旧格式：
 *  - 旧版存 number[]（如 [74880, 500000]）→ 转为 [{ baud }]
 *  - 新版存 CustomBaudRate[] → 原样返回
 */
export function loadCustomBaudRates(raw: unknown): CustomBaudRate[] {
  if (!Array.isArray(raw)) return []
  if (raw.length && typeof raw[0] === 'number') {
    return (raw as number[]).map((baud) => ({ baud }))
  }
  return raw as CustomBaudRate[]
}
