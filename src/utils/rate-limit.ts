// 字节速率 + 包间延时双旋钮限速（纯逻辑，可单测）。
// 每包后计算需要等待的毫秒数，取二者更严者：
//   interChunkDelay：固定包间延时（bootloader 常见，粗粒度）
//   bytesPerSecond：令牌桶式平滑限速——理论应发 bytesPerSecond*elapsed/1000，
//                   实际已发超出理论值（超前）时 sleep 差额。比 setInterval 精确、不漂移。

/**
 * @param now        当前时间戳 ms（由调用方注入，测试可传固定值）
 * @param startedAt  下发起始时间戳 ms
 * @param sent       已确认下发的字节数
 * @param bps        字节速率上限 B/s（0 = 不限速）
 * @param interDelay 包间延时 ms（bps 不限速时的兜底等待）
 */
export function paceDelay(
  now: number,
  startedAt: number,
  sent: number,
  bps: number,
  interDelay: number
): number {
  if (!bps) return interDelay
  const elapsed = now - startedAt
  const target = (bps * elapsed) / 1000
  const deficit = sent - target
  return Math.max(interDelay, deficit > 0 ? (deficit / bps) * 1000 : 0)
}