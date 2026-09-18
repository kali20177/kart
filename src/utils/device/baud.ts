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
 * 读取持久化的自定义波特率，兼容旧格式并做防御性清洗：
 *  - 旧版存 number[]（如 [74880, 500000]）→ 转为 [{ baud }]
 *  - 新版存 CustomBaudRate[] → 保留 baud 与 note
 *  - 丢弃 baud 缺失/非法（非正整数或越界）或重复的项；note 非字符串或纯空白则清除
 */
export function loadCustomBaudRates(raw: unknown): CustomBaudRate[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const result: CustomBaudRate[] = []
  for (const item of raw) {
    if (typeof item === 'number') {
      if (isValidBaud(item) && !seen.has(item)) {
        seen.add(item)
        result.push({ baud: item })
      }
      continue
    }
    if (item == null || typeof item !== 'object') continue
    const baud = (item as { baud?: unknown }).baud
    if (typeof baud !== 'number' || !isValidBaud(baud) || seen.has(baud)) continue
    seen.add(baud)
    const note = (item as { note?: unknown }).note
    result.push(typeof note === 'string' && note.trim() ? { baud, note } : { baud })
  }
  return result
}
