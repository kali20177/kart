/**
 * 把文本作为文件下载（Blob + 临时 <a> click）。
 * 浏览器与 Electron 渲染层均可直接用。
 */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
