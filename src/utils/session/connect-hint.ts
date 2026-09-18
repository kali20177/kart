import type { TransportType } from '@/types'

/** 网络传输连接失败时可追加的操作提示 i18n key；串口无（原因通常一目了然，不占横幅）。 */
export type TransportHintKey = 'transport.rttHint' | 'transport.tcpHint'

/** 传输类型 → 失败提示 key。RTT/TCP 有对应的操作提示（先启动 Server / 核对主机端口），串口返回 null。 */
export function transportHintKey(transport: TransportType): TransportHintKey | null {
  if (transport === 'rtt') return 'transport.rttHint'
  if (transport === 'tcp') return 'transport.tcpHint'
  return null
}

/** 组装连接失败横幅文案：错误信息在上，操作提示另起一行在下；无提示时原样返回。 */
export function formatConnectFailure(message: string, hint: string | null): string {
  return hint ? `${message}\n${hint}` : message
}