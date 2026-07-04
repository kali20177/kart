// 消息搜索/过滤的纯函数 —— 无框架依赖，便于单测。
// 与 useMessageSearch composable 配合：composable 负责响应式编排，这里负责匹配算法。

export interface Range {
  start: number
  end: number
}

/**
 * 在文本中不区分大小写地搜索子串，返回所有命中区间（含重叠，未合并）。
 * 区间为字符偏移：[start, end)。空关键字返回空数组。
 * 供 ASCII 视图的文本搜索 / 高亮使用。
 */
export function findTextRanges(text: string, kw: string): Range[] {
  if (!kw) return []
  const ranges: Range[] = []
  const lower = text.toLowerCase()
  const lowerKw = kw.toLowerCase()
  let pos = 0
  while ((pos = lower.indexOf(lowerKw, pos)) !== -1) {
    ranges.push({ start: pos, end: pos + lowerKw.length })
    pos++
  }
  return ranges
}

/**
 * 按 start 排序后合并相交或相邻的区间。
 * 用于修复重叠命中（如 "aaaa" 搜 "aa" → [0,2],[1,3],[2,4]）直接按区间 slice 造成的
 * 文本重复/错位：合并成 [0,4] 后再切分渲染。
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice()
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: Range[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const cur = sorted[i]
    if (cur.start <= last.end) {
      // 相交或相邻 → 扩展右端
      if (cur.end > last.end) last.end = cur.end
    } else {
      merged.push({ start: cur.start, end: cur.end })
    }
  }
  return merged
}

/**
 * 提取 timestamp 的当日毫秒数（时×3600000 + 分×60000 + 秒×1000 + 毫秒）。
 * 时间筛选按当日时间过滤，与气泡显示的 HH:MM:SS.mmm 一致。
 * 注意：不处理跨午夜区间（会话通常不跨日）。
 */
export function timeOfDay(ts: number): number {
  const d = new Date(ts)
  return (
    d.getHours() * 3600000 +
    d.getMinutes() * 60000 +
    d.getSeconds() * 1000 +
    d.getMilliseconds()
  )
}

/**
 * 解析用户输入的时间字符串 → 当日毫秒数。
 * 接受 "HH:MM"、"HH:MM:SS"、"HH:MM:SS.mmm"。非法（越界、格式不符）返回 null。
 */
export function parseTimeInput(val: string): number | null {
  const m = val.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const s = parseInt(m[3] ?? '0', 10)
  const ms = parseInt((m[4] ?? '0').padEnd(3, '0'), 10)
  if (h > 23 || min > 59 || s > 59) return null
  return h * 3600000 + min * 60000 + s * 1000 + ms
}
