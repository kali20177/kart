// 纯解析原语：把「字节流 → 每通道数值」做成无状态纯函数，可独立单测。
// X 时间戳策略与 carryover/labelIndex 跨回调状态由上层解析器
// （见 waveform-parser.ts 的 TextLineParser）持有，本函数不感知。

/**
 * 文本行解析器（Arduino Serial.println 风格）。
 *
 * 把字节流解码为文本，按换行切行，每行解析为若干十进制数字 -> 多通道采样。
 * 返回 { perChannel, remainder }，上层解析器据此构造 X 时间戳并维护跨回调状态。
 *
 * 设计要点：
 *  - **一行 = 一个采样点**。
 *  - 数字按 `[,\s;]+` 分割（逗号 / 空白 / 分号均可），覆盖 Arduino 常见写法：
 *      Serial.println(analogRead(A0))            -> 单值/行 -> 1 通道
 *      Serial.print(a); Serial.print(','); ...   -> a,b/行  -> 2 通道
 *  - 支持 label:value 格式，按标签名匹配通道：
 *      Serial.print("Sin:"); Serial.print(x); Serial.print(",Cos:"); Serial.println(y);
 *      -> "Sin:0.5,Cos:0.86" -> 标签 "Sin"→通道0、"Cos"→通道1
 *  - 通道数由数据内容自动检测——无标签 token 按递增位置、有标签 token 按 labelIndex 分配；
 *    不依赖外部配置。
 *  - 数值不足的通道补 NaN（uPlot spanGaps 跨连，渲染为缺口）；
 *    整行无有效数值则跳过（不产生采样点）。
 *  - carryover 为上批未结束的半截行**字符串**，跨回调拼到下批开头（半截行不立即成点，
 *    等下批补全换行后再切，避免把 `12.` + `5` 误判成两个点）。
 *  - **标记模式**（opts.linePrefix 非空）：带标记的行才是数据（标记须是该行第一个可打印
 *    内容，见 markerIndex），其余行当文本。
 *    这是「日志与波形同流」的解法——宽松模式下日志散文里的数字会被当成采样值
 *    （`[W25Q64] ... 8 MB, 128 blocks` → 两个假通道），标记模式让宿主不再猜：
 *    用户声明了哪行是数据，那么写错就该报错（rejected），而不是静默画错。
 *
 * 无状态纯函数，不依赖 Vue，可独立单测。
 */

export interface ParseResult {
  /** perChannel[ch] = 本批新增的采样值数组（按行到达顺序；缺失值用 NaN 占位） */
  perChannel: number[][]
  /** 上批遗留的半截行字符串，原样传回给下次 parseTextSamples 的 carryover */
  remainder: string
  /** 标记模式下带标记、但行内有非法 token 而被整行作废的行（供上层计数提示）；宽松模式恒为空 */
  rejected: string[]
  /** carryover 超长被丢弃（设备长时间不发换行）；丢弃后从下一批重新起算 */
  remainderTruncated: boolean
}

/** 解析选项（宽松/标记两种模式）。未传 linePrefix = 宽松模式，行为与历史一致。 */
export interface ParseOptions {
  /**
   * 绘图行标记前缀（如 `>`）。非空 = 标记模式：
   * - 只有带该标记的行才被当作数据（标记须为该行第一个可打印内容），其余行一律当文本
   *   （不产生采样、不报错）；
   * - 标记行去掉前缀后，token 必须**全部**是合法数值/`标签:数值`，否则整行作废并记入 rejected。
   *
   * 严格性只在标记行上生效——这正是标记模式的意义：用户已声明「这行是数据」，
   * 那么写错的代价应该是可见的报错，而不是被静默解析成错误的通道值。
   */
  linePrefix?: string
}

/**
 * 未终止行长上限（字符数）：carryover 超过此长度即丢弃。
 * 设备一旦长时间不发换行（如死循环里只 print 不 println），carryover 会随每批字节无界增长，
 * 且会把后续正常数据一并粘成畸形行。Lissio 的 FireWater 引擎在 8192 字节处直接清空缓冲，此处同取该量级。
 */
export const MAX_REMAINDER = 8192

/**
 * 是否「噪声字节」：不可打印控制字符（\t 除外——它是空白，人写的缩进不算帧残渣）。
 *
 * 用途见 markerIndex()：二进制帧（DictLog 之类）不带换行，其后紧跟的文本行会被切
 * 成同一「行」，标记前因此存在帧尾残渣。可打印字符则不可能是帧残渣——那说明这行
 * 本来就是文本，标记字符出现在文本里就不该算数。
 */
function isNoiseByte(code: number): boolean {
  return (code < 0x20 && code !== 0x09) || code === 0x7f
}

/**
 * 标记在行内的位置；-1 = 本行不是标记行。
 *
 * 契约：标记必须出现在**行首**，或**紧跟在一个噪声字节之后**（即这一行的第一个
 * 可打印内容就是标记）。这样两条同时成立：
 * - 纯文本线上 `>Temp:1,2` 顶格打印 → 命中；
 * - 混二进制帧的线上（真机 RTT：DictLog 帧尾无换行）`…\x08>Temp:1,2` → 命中；
 * - 普通日志 `x>1,2` / `compare > 1,2` → 标记前是可打印文本 → 不命中，仍是日志。
 *
 * 失败方向是「漏认」而非「误认」：帧尾恰好是可打印字节时那一行被当文本跳过，
 * 下一行照常——宁可少一个点，不可把日志数字画进曲线。
 */
function markerIndex(line: string, prefix: string): number {
  let at = line.indexOf(prefix)
  while (at >= 0) {
    if (at === 0 || isNoiseByte(line.charCodeAt(at - 1))) return at
    at = line.indexOf(prefix, at + 1)
  }
  return -1
}

/** 单个 token 的解析结果 */
interface TokenValue {
  /** 标签名（仅 label:value 格式时有值）；无标签 token 为 undefined */
  label?: string
  /** 解析出的数值；null 表示无效 */
  value: number | null
}

/**
 * 手写有限数值校验：接受 +/-、小数、科学计数法，且**整串消耗完**才合法。
 * 比 Number()/parseFloat 严格 -- 正确拒绝 `12abc`、`1.2.3` 这类，避免误当成数值。
 * 空串、纯符号、指数无数字均返回 null。
 */
function parseFiniteNumber(token: string): number | null {
  const text = token.trim().toLowerCase()
  if (!text) return null

  let i = 0
  if (text[i] === '+' || text[i] === '-') i += 1

  let digits = 0
  while (text[i] >= '0' && text[i] <= '9') { digits += 1; i += 1 }
  if (text[i] === '.') {
    i += 1
    while (text[i] >= '0' && text[i] <= '9') { digits += 1; i += 1 }
  }
  if (digits === 0) return null

  if (text[i] === 'e') {
    i += 1
    if (text[i] === '+' || text[i] === '-') i += 1
    let expDigits = 0
    while (text[i] >= '0' && text[i] <= '9') { expDigits += 1; i += 1 }
    if (expDigits === 0) return null
  }

  if (i !== text.length) return null

  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * 解析单个 token：检测 label:value 格式，提取标签名与数值。
 * - 匹配 `Label:value` → { label: "Label", value: parseFiniteNumber(value) }
 * - 不匹配 → { value: parseFiniteNumber(token) }
 * 标签名规则：字母或下划线开头，后可接字母/数字/下划线（符合 C/Arduino 变量名习惯）。
 */
function parseToken(token: string): TokenValue {
  const trimmed = token.trim()
  const labelMatch = trimmed.match(/^([a-zA-Z_]\w*)\s*:\s*(\S.*)$/)
  if (labelMatch) {
    const v = parseFiniteNumber(labelMatch[2])
    if (v !== null) return { label: labelMatch[1], value: v }
    // 标签有效但数值无效 → 整 token 无效
    return { value: null }
  }
  return { value: parseFiniteNumber(token) }
}

/**
 * 把字节流按行切，读出每通道数值。
 *
 * @param bytes      本批到达的字节
 * @param carryover  上批遗留的半截行字符串（拼到本批文本前）
 * @param labelIndex 标签→通道索引映射（由上层解析器持有，非响应式）。
 *                   首次传 undefined 或不传 → 按位置匹配（兼容无标签数据）。
 *                   有值则该 Map 会原地更新（新标签分配新索引），调用方可通过
 *                   .size 感知新增通道数。
 * @param opts       解析选项。linePrefix 非空 = 标记模式（只认该前缀开头的行，
 *                   且行内 token 必须全部合法）；不传 = 宽松模式（历史行为）。
 */
export function parseTextSamples(
  bytes: Uint8Array,
  carryover: string = '',
  labelIndex?: Map<string, number>,
  opts?: ParseOptions
): ParseResult {
  const minChannels = 1
  const prefix = opts?.linePrefix ?? ''
  const decoded = carryover + new TextDecoder().decode(bytes)

  // 按 \r\n / \n / \r 切行；末尾未结束的半截行作为 remainder 留给下批
  const parts = decoded.split(/\r\n|\n|\r/)
  let remainder = parts.pop() ?? ''

  // 初始通道数 = 1；解析过程中按 token 位置 / 标签自动扩容
  const perChannel: number[][] = [[]]
  const rejected: string[] = []

  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 标记模式：本行没有「顶格/紧跟帧残渣」的标记 → 当文本（日志）跳过，永不产生采样。
    let payload = trimmed
    if (prefix) {
      const at = markerIndex(line, prefix)
      if (at < 0) continue
      payload = line.slice(at + prefix.length).trim()
      const bodyTokens = payload.split(/[,\s;]+/).filter(Boolean)
      if (bodyTokens.length === 0 || !bodyTokens.every((t) => parseToken(t).value !== null)) {
        // 标记行写错：整行作废并上报（绝不静默成点——这是标记模式对「不猜」的兑现）
        rejected.push(trimmed)
        continue
      }
    }

    const tokens = payload.split(/[,\s;]+/).filter(Boolean)
    const values = new Map<number, number>()
    let posCounter = 0 // 无标签 token 的递增位置计数器

    for (const token of tokens) {
      const tv = parseToken(token)
      if (tv.value === null) continue

      let ch: number
      if (tv.label && labelIndex) {
        // 标签化 token → 按标签名匹配 / 分配索引
        const existing = labelIndex.get(tv.label)
        if (existing != null) {
          ch = existing
        } else {
          ch = labelIndex.size
          labelIndex.set(tv.label, ch)
        }
      } else {
        // 无标签 token → 按递增位置
        ch = posCounter
        posCounter++
      }

      // 动态扩容 perChannel（标签模式或 pos 增长均可触发）
      while (perChannel.length <= ch) {
        perChannel.push([])
      }
      values.set(ch, tv.value)
    }

    if (values.size === 0) continue // 整行无有效数值 → 跳过，不产生采样点

    // 有效通道数 ≥ minChannels；不足补 NaN
    const chCount = Math.max(minChannels, perChannel.length)
    for (let c = 0; c < chCount; c++) {
        perChannel[c].push(values.has(c) ? values.get(c)! : NaN)
    }
  }

  // 未终止长行上限：设备不发换行时 carryover 会无界增长，且会把后续数据粘成畸形行。
  // 丢弃后从下一批重新起算（宁可少一段，不可无限攒）。
  let remainderTruncated = false
  if (remainder.length > MAX_REMAINDER) {
    remainder = ''
    remainderTruncated = true
  }

  return { perChannel, remainder, rejected, remainderTruncated }
}
