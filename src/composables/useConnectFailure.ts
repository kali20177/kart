import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { TransportType } from '@/types'
import { formatConnectFailure, transportHintKey } from '@/utils/connect-hint'

/**
 * 连接失败横幅（托盘 toast）的统一上报：网络传输（RTT/TCP）在错误信息下方换行追加
 * 操作提示（RTT 需先启动 Server、TCP 需核对主机/端口），串口只报错误本身。
 * 提示较长，放长停留时间并允许手动关闭，避免读不完就消失。
 * 连接入口有两处（ConnectionBar 展开态连接按钮、SessionTab 收起态电源按钮），共用此上报保证提示一致。
 */
export function useConnectFailure(transport: () => TransportType) {
  const { t } = useI18n()
  const message = useMessage()

  return function reportConnectFailure(e: unknown): void {
    const base = e instanceof Error ? e.message : t('conn.connectFailed')
    const key = transportHintKey(transport())
    message.error(formatConnectFailure(base, key ? (t(key) as string) : null), {
      duration: 6000,
      closable: key !== null
    })
  }
}