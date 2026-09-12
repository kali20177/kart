/**
 * 应用自升级的纯逻辑层（无 Electron / electron-updater 依赖，可独立单测）。
 *
 * 职责：
 * - 状态机 reducer：electron-updater 原始事件 → 渲染端契约状态（UpdaterState）
 * - gate 判定（isUpdaterActive）：打包/平台/渠道（AppImage）三重条件
 * - 平台无关的展示格式化（字节/速率/ETA）
 *
 * 渲染端契约（UpdaterState / UpdaterProgress / UpdaterVersionInfo）是本模块的
 * 公共出口，不泄漏 electron-builder 特有字段（files/blockmap/path 等），
 * 保证未来迁移 saucer 后端时前端零改动（见 docs/upgrade-design.md §15）。
 */

export type UpdaterStatus =
  | 'unavailable' // 非打包 / 平台不支持（如 Linux deb 渠道）
  | 'idle'        // 尚未检查
  | 'checking'    // 检查中
  | 'available'   // 发现新版本
  | 'not-available' // 已是最新
  | 'downloading' // 下载中
  | 'downloaded'  // 下载完成，待重启安装
  | 'error'       // 检查/下载失败

/** 下载进度（渲染端展示用） */
export interface UpdaterProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

/** 目标版本信息（渲染端展示用，仅保留公开字段） */
export interface UpdaterVersionInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  totalSize?: number
}

/** 渲染端完整状态快照（getState / updater:event 统一此形态） */
export interface UpdaterState {
  status: UpdaterStatus
  /** 目标版本信息（available/downloaded 时有值） */
  info: UpdaterVersionInfo | null
  /** 下载进度（downloading 时有值） */
  progress: UpdaterProgress | null
  /** 错误描述（error 时有值） */
  error: string | null
}

/** electron-updater 原始 UpdateInfo 的最小结构——只取我们关心的公开字段 */
export interface RawUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  files?: Array<{ size?: number }>
}

/** 驱动 reducer 的语义事件（主进程把 electron-updater 事件映射为此形态） */
export type UpdaterEvent =
  | { type: 'check-start' }
  | { type: 'checking' }
  | { type: 'available'; info: RawUpdateInfo }
  | { type: 'not-available' }
  | { type: 'download-start' }
  | { type: 'progress'; progress: UpdaterProgress }
  | { type: 'downloaded'; info: RawUpdateInfo }
  | { type: 'cancel' }
  | { type: 'error'; message: string }
  | { type: 'unavailable' }

export function createUpdaterState(): UpdaterState {
  return { status: 'idle', info: null, progress: null, error: null }
}

/**
 * gate 判定：自动更新能力位。
 * - 非打包（浏览器/electron:dev）且未显式开启 dev 验证（KART_UPDATE_DEV=1）→ 不可用；
 * - Linux 非 AppImage 启动（deb 渠道）→ electron-builder 无 deb 自动更新，不可用
 *   （dev 验证模式放行，便于本地调试）。
 */
export function isUpdaterActive(opts: {
  isPackaged: boolean
  devEnabled: boolean
  platform: NodeJS.Platform
  appImage: boolean
}): boolean {
  if (!opts.isPackaged && !opts.devEnabled) return false
  if (opts.platform === 'linux' && !opts.appImage && !opts.devEnabled) return false
  return true
}

/** 各文件 payload 大小求和（有 files 且至少一个有效尺寸时返回，否则 undefined） */
export function totalUpdateSize(info: RawUpdateInfo | null | undefined): number | undefined {
  if (!info?.files?.length) return undefined
  const total = info.files.reduce((sum, f) => sum + (f.size ?? 0), 0)
  return total > 0 ? total : undefined
}

/** HTML 命名实体 → 字符（覆盖 GitHub Atom feed 常见转义） */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
  sect: '§'
}

/** 闭合（或自闭合）后应换行的块级标签——GitHub Atom feed 把 Release body 渲染为 HTML，
 *  不转成换行的话 `</p>` 等被整体剥掉后内容会挤成一行 */
const BLOCK_TAGS = [
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'br', 'hr', 'section', 'article', 'header', 'footer', 'figure', 'figcaption'
]

/**
 * releaseNotes → 可读纯文本。
 *
 * electron-updater（GitHub provider）拿到的 releaseNotes 是 GitHub Atom feed 的
 * `<content>`——即 Release body 的 **HTML 渲染**（`<p>/<ul>/<a>` 等）；本函数在
 * 主进程/纯逻辑边界把标签剥掉、块级边界转成换行、实体解码，得到客户端可直接展示的
 * 纯文本（渲染端明文渲染，不经 v-html，规避 CSP/注入）。输入若是 markdown（本地
 * 元数据/ReleaseNoteInfo[] 场景）则原样透传——不含标签与实体时不会被改动。
 */
export function sanitizeReleaseNotes(notes: string | null | undefined): string | undefined {
  if (notes == null || notes.trim() === '') return undefined
  // <a href="...">可见文本</a> → 可见文本（URL 不同且为 http(s) 时附上链接，纯文本不丢跳转目标）
  const withLinks = notes.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, '').trim()
    if (!label) return ''
    return /^https?:\/\//i.test(href) && !href.includes(label) ? `${label} (${href})` : label
  })
  // <img alt="..."> → [alt]（无 alt 的装饰图直接丢弃）
  const withImgs = withLinks.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*\/?>/gi, (_m, alt: string) => (alt ? `[${alt}]` : ''))
  // <li> 开头转列表符号
  const withList = withImgs.replace(/<li\b[^>]*>/gi, '\n- ')
  // 其余块级标签（开/闭）→ 换行
  const withBreaks = withList.replace(new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi'), '\n')
  // 剥掉剩余全部标签（内联样式/字体等）
  const noTags = withBreaks.replace(/<[^>]+>/g, '')
  // 实体解码：命名 + 十进制/十六进制字符引用
  const decoded = noTags.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent.startsWith('#x')) {
      const code = parseInt(ent.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m
    }
    if (ent.startsWith('#')) {
      const code = parseInt(ent.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m
    }
    return HTML_ENTITIES[ent] ?? m
  })
  // 行尾空白清理 + 连续空行收敛为单个换行（HTML 块级边界产生的空行压平）+ 首尾修剪
  // （行首缩进保留，代码块/对齐不被破坏）
  return (
    decoded
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim() || undefined
  )
}

/** 原始 UpdateInfo → 渲染端契约（只保留公开字段 + 求和大小；releaseNotes 清洗为纯文本） */
export function toVersionInfo(info: RawUpdateInfo | null | undefined): UpdaterVersionInfo | null {
  if (!info) return null
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: sanitizeReleaseNotes(info.releaseNotes),
    totalSize: totalUpdateSize(info)
  }
}

/**
 * 事件 → 状态迁移（纯函数）。
 * checking/downloading 的停留由主进程的进行中守卫保证，这里只做单步映射。
 */
export function updaterReducer(prev: UpdaterState, ev: UpdaterEvent): UpdaterState {
  switch (ev.type) {
    case 'check-start':
    case 'checking':
      return { ...prev, status: 'checking', error: null }
    case 'available':
      return {
        ...prev,
        status: 'available',
        info: toVersionInfo(ev.info) ?? prev.info,
        progress: null,
        error: null
      }
    case 'not-available':
      return { ...prev, status: 'not-available', info: null, progress: null, error: null }
    case 'download-start':
      return {
        ...prev,
        status: 'downloading',
        progress: prev.progress ?? { percent: 0, bytesPerSecond: 0, transferred: 0, total: prev.info?.totalSize ?? 0 },
        error: null
      }
    case 'progress':
      return { ...prev, status: 'downloading', progress: ev.progress }
    case 'downloaded':
      return {
        ...prev,
        status: 'downloaded',
        info: toVersionInfo(ev.info) ?? prev.info,
        progress: null,
        error: null
      }
    case 'cancel':
      // 用户取消下载：回到「发现新版本」（info 保留），可重新下载
      return { ...prev, status: 'available', progress: null, error: null }
    case 'error':
      return { ...prev, status: 'error', error: ev.message, progress: null }
    case 'unavailable':
      return { ...prev, status: 'unavailable', progress: null, error: null }
    default:
      return prev
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** 字节数人类可读（1024 进制，>=100 时取整，否则一位小数） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let u = 0
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${BYTE_UNITS[u]}`
}

/** 速率（字节/秒 → 可读） */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 剩余时间估算；流式下载起始段无速率/总量时返回 '--' */
export function formatEta(transferred: number, total: number, bytesPerSecond: number): string {
  if (!(bytesPerSecond > 0) || !(total > 0)) return '--'
  const secs = Math.ceil(Math.max(0, total - transferred) / bytesPerSecond)
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
  if (secs >= 60) return `${Math.floor(secs / 60)}m${secs % 60}s`
  return `${secs}s`
}