// 消息搜索/过滤 composable —— 从 MessageList 抽离，便于测试与复用。
// 纯响应式编排：匹配算法在 src/utils/search.ts 与 hex.ts，本文件只做组合。
import { computed, type ComputedRef, type Ref } from 'vue'
import type { Direction, Encoding, Message } from '@/types'
import { decodeBytes } from '@/utils/encoding'
import { findByteRanges, parseHexInput } from '@/utils/hex'
import { findTextRanges, mergeRanges, timeOfDay } from '@/utils/search'

export interface SearchOptions {
  messages: Ref<readonly Message[]>
  keyword: Ref<string>
  searchMode: Ref<'text' | 'hex'>
  encoding: Ref<Encoding>
  dirFilter: Ref<'all' | Direction>
  /** 当日毫秒数，null 表示无该侧约束 */
  timeStart: Ref<number | null>
  timeEnd: Ref<number | null>
}

export interface Range {
  start: number
  end: number
}

export interface SearchResult {
  /** 过滤后的消息列表（方向 + 时间 + 关键字） */
  filtered: ComputedRef<Message[]>
  /** message.id → 命中区间（文本模式=字符偏移、HEX 模式=字节偏移）；仅含命中帧 */
  matchRanges: ComputedRef<Map<number, Range[]>>
  /** 命中帧数量（= matchRanges.size） */
  matchCount: ComputedRef<number>
  /** HEX 输入解析错误信息，null 表示无错误 */
  hexError: ComputedRef<string | null>
}

/**
 * 搜索/过滤编排。
 *
 * 两套坐标系：
 *   - 文本搜索：在 decodeBytes 解码后的字符串上匹配，命中为字符偏移（高亮前合并重叠区间）。
 *   - HEX 搜索：在原始 bytes 上匹配，命中为字节偏移（高亮按字节 Set 天然去重）。
 *
 * HEX 解析失败时：hexError 给出原因，filtered 不按关键字过滤（仅方向+时间），
 * matchRanges 为空、matchCount=0（导航隐藏），用户可看到错误并修正输入。
 */
export function useMessageSearch(opts: SearchOptions): SearchResult {
  const { messages, keyword, searchMode, encoding, dirFilter, timeStart, timeEnd } = opts

  // HEX 模式下的解析结果（仅 keyword 变化时重算）
  const hexParse = computed(() => {
    if (searchMode.value !== 'hex') return null
    const kw = keyword.value.trim()
    if (!kw) return null
    return parseHexInput(kw)
  })

  const hexError = computed(() => {
    if (searchMode.value !== 'hex') return null
    const kw = keyword.value.trim()
    if (!kw) return null
    const r = parseHexInput(kw)
    return r.ok ? null : (r.error ?? 'HEX 解析失败')
  })

  const filtered = computed(() => {
    const kw = keyword.value.trim()
    const dir = dirFilter.value
    const enc = encoding.value
    const t0 = timeStart.value
    const t1 = timeEnd.value
    const mode = searchMode.value
    const parsed = hexParse.value

    return messages.value.filter((m) => {
      // 方向过滤
      if (dir !== 'all' && m.direction !== dir) return false

      // 时间范围过滤（当日毫秒数）
      if (t0 !== null || t1 !== null) {
        const tod = timeOfDay(m.timestamp)
        if (t0 !== null && tod < t0) return false
        if (t1 !== null && tod > t1) return false
      }

      // 关键字过滤
      if (kw) {
        if (mode === 'hex') {
          // 解析失败 → 不按关键字过滤（让用户看到错误徽标，列表不空）
          if (!parsed || !parsed.ok) return true
          return findByteRanges(m.bytes, parsed.bytes).length > 0
        }
        const text = decodeBytes(m.bytes, enc)
        return findTextRanges(text, kw).length > 0
      }

      return true
    })
  })

  const matchRanges = computed(() => {
    const map = new Map<number, Range[]>()
    const kw = keyword.value.trim()
    if (!kw) return map

    const mode = searchMode.value
    const enc = encoding.value

    if (mode === 'hex') {
      const parsed = hexParse.value
      if (!parsed || !parsed.ok) return map
      for (const m of filtered.value) {
        const ranges = findByteRanges(m.bytes, parsed.bytes)
        if (ranges.length > 0) map.set(m.id, ranges) // 字节偏移，无需合并
      }
    } else {
      for (const m of filtered.value) {
        const text = decodeBytes(m.bytes, enc)
        const ranges = findTextRanges(text, kw)
        if (ranges.length > 0) map.set(m.id, mergeRanges(ranges)) // 字符偏移，合并后供切片
      }
    }
    return map
  })

  const matchCount = computed(() => matchRanges.value.size)

  return { filtered, matchRanges, matchCount, hexError }
}
