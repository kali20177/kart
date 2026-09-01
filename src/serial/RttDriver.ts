// RTT 传输驱动 —— SEGGER RTT 数据流经 TCP 承载（J-Link RTT Server 默认 19021 /
// OpenOCD rtt server 均可），端点即 "host:port"。
// 完全复用 TcpDriver 的字节流通路，仅以独立驱动类型标识区别于普通 TCP，
// 供会话区分、默认端口（19021）与提示文案（需先启动 RTT Server）使用。
import { TcpDriver, type ElectronTcp } from './TcpDriver'

export class RttDriver extends TcpDriver {
  constructor(api?: ElectronTcp) {
    super(api, 'rtt')
  }
}