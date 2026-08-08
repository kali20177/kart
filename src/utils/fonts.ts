interface LocalFontFace {
  family: string
  fullName: string
  postscriptName: string
  style: string
}

type QueryLocalFonts = () => Promise<LocalFontFace[]>

/**
 * 枚举操作系统已安装字体（Local Font Access API，Chromium 安全上下文），
 * 返回去重排序后的 font family 名列表。供终端字体选择使用——只有系统真实存在的
 * 字体才可选，避免预定义列表里字体不存在时 xterm 回退渲染导致宽度错乱。
 *
 * 不支持（非 Chromium / 非安全上下文）或权限被拒时返回空数组，调用方降级为手动输入。
 */
export async function listSystemFonts(): Promise<string[]> {
  const q = typeof window !== 'undefined'
    ? (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
    : undefined
  if (typeof q !== 'function') return []
  try {
    const fonts = await q()
    const seen = new Set<string>()
    for (const f of fonts) {
      if (typeof f?.family === 'string' && f.family) seen.add(f.family)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  } catch {
    // 权限被拒或 API 异常：返回空，让 UI 提示手动输入
    return []
  }
}
