// ============ 波形 X 轴时钟权威 ============
//
// 波形 X 时间戳的语义：串口域按波特率位时间合成「线缆时刻」，网络域（TCP/RTT）
// 用到达时间。设计依据 docs/lissio-research.md「时钟权威」一节：
//   - 一条流锁定一个逻辑时钟域（serialport/webserial/mock → 合成位时钟；
//     tcp/rtt/pty 等 → 到达时间）；
//   - 串口批内按「本批完整行的字节数 × 每字节位时间」均摊推进（对齐 Lissio
//     SerialNominal 的批内均摊），消除批内 +1ms 假间距与合批 clump；
//   - 批间空档（设备暂停）由 max(now, lastSampleX) 天然保留——纯累计模型会把
//     100ms 间隔压成 1ms，必须用批锚定混合；
//   - 域切换不重置单调下限：X 必须全局递增（uPlot 要求），真实时间只向前走，
//     保留 floor 既保证单调、又不改变「新域锚定 now」的实际效果。
//
// X 始终是 epoch 毫秒（与到达时间同域），uPlot 时间轴 / tooltip / CSV 相对秒
// 全部兼容，不引入「从 0 起算」导致的 1970 轴。

import type { DriverType, PortOptions } from '@/types'

/** 时钟域：wire=串口合成位时钟；arrival=到达时间（网络等无波特率语义的传输） */
export type ClockDomain = 'wire' | 'arrival'

/** 解析器每次 ingest 实时读取的时钟配置（调用方返回最新值，支持运行中热更新） */
export interface WireClockConfig {
  domain: ClockDomain
  baudRate: number
  dataBits: PortOptions['dataBits']
  parity: PortOptions['parity']
  stopBits: PortOptions['stopBits']
}

/** 每字节线缆传输位数：1 起始位 + 数据位 + (奇偶校验 ? 1 : 0) + 停止位（停止位可为 1.5） */
export function bitsPerByte(dataBits: number, parity: PortOptions['parity'], stopBits: number): number {
  return 1 + dataBits + (parity === 'none' ? 0 : 1) + stopBits
}

/** 每字节传输耗时（毫秒） */
export function byteTimeMs(baudRate: number, bits: number): number {
  return (bits / baudRate) * 1000
}

/** driverType → 时钟域：串口系（serialport/webserial，mock 模拟串口节奏）走合成，网络/其它走到达 */
export function resolveClockDomain(driverType: DriverType | string): ClockDomain {
  return driverType === 'serialport' || driverType === 'webserial' || driverType === 'mock' ? 'wire' : 'arrival'
}

/**
 * 串口批内位时钟推进（无状态纯函数，状态由解析器持有）。
 *
 * 语义：base = max(now, lastSampleX)，X_i = base + i*step (i=1..n)。
 *  - 批内严格单调（步长恒正）；同毫秒连续批 base=lastSampleX，不折叠；
 *  - 批间空档（设备暂停）由 now 追平保留；
 *  - n=0 或 step 非法时原样返回空样本与未推进的 lastSampleX（空批不影响锚点）。
 */
export function wireBatchXs(
  now: number,
  n: number,
  step: number,
  lastSampleX: number
): { xs: number[]; lastSampleX: number } {
  if (n <= 0 || !(step > 0)) return { xs: [], lastSampleX }
  const xs: number[] = []
  let x = Math.max(now, lastSampleX)
  for (let i = 1; i <= n; i++) {
    x += step
    xs.push(x)
  }
  return { xs, lastSampleX: x }
}