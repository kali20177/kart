/**
 * 将波形数据导出为 CSV 字符串（含 BOM，Excel 可直接打开）。
 * data 格式为 [X, ch1, ch2, ...]（与 waveform.data / waveform.history 一致）。
 * X 为绝对时间戳（毫秒），导出时转为相对秒数（从首个采样点开始）。
 * 仅输出 visibleChannels 中为 true 的通道列。
 * 保持 CSV 为干净矩形表格，可直接导入 pandas / MATLAB。
 */
export function exportWaveformAsCsv(
  data: number[][],
  visibleChannels: boolean[],
  textLabels?: string[]
): string {
  const header = buildHeader(visibleChannels, textLabels)
  const rows: string[] = [header]

  const xArr = data[0]
  if (xArr && xArr.length > 0) {
    const startX = xArr[0]
    for (let r = 0; r < xArr.length; r++) {
      const t = (xArr[r] - startX) / 1000
      const cols: string[] = [t.toFixed(3)]
      for (let c = 0; c < visibleChannels.length; c++) {
        if (!visibleChannels[c]) continue
        const val = data[c + 1]?.[r]
        cols.push(val != null ? String(val) : '')
      }
      rows.push(cols.join(','))
    }
  }

  return '﻿' + rows.join('\n') + '\n'
}

/** 根据可见通道数组与可选标签数组构建 CSV 表头 */
function buildHeader(visibleChannels: boolean[], textLabels?: string[]): string {
  const labels: string[] = ['time_sec']
  for (let i = 0; i < visibleChannels.length; i++) {
    if (visibleChannels[i]) labels.push(textLabels?.[i] ?? `CH${i + 1}`)
  }
  return labels.join(',')
}