import type { SerialDriver } from '@/types'
import { WebSerialDriver } from './WebSerialDriver'
import { SerialPortDriver } from './SerialPortDriver'
import { MockSerialSource } from '@/mock/MockSerialSource'

export type DriverType = 'mock' | 'webserial' | 'serialport'

/**
 * 选择驱动类型，优先级：
 *  1. Electron 环境 → serialport（主进程串口库，返回真实 COM 口名）
 *  2. DEV 模式 ?mock 查询参数 → mock（开发者调试用）
 *  3. 浏览器环境（Web Serial API）→ webserial
 *  4. 兜底 → mock
 */
function resolveDriverType(): DriverType {
  // Electron 环境：始终使用 serialport
  const isElectron = typeof window !== 'undefined' && !!(window as any).electron?.serial
  if (isElectron) return 'serialport'

  // DEV 模式：?mock 查询参数强制使用 mock 驱动
  if (import.meta.env.DEV) {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.has('mock')) return 'mock'
    } catch { /* SSR / 无 window 环境 */ }
  }

  // 浏览器环境（Web Serial API）
  if (typeof navigator !== 'undefined' && 'serial' in navigator) {
    return 'webserial'
  }

  // 兜底
  return 'mock'
}

let _driverType: DriverType | null = null
let _driver: SerialDriver | null = null

/** 获取当前驱动类型 */
export function getDriverType(): DriverType {
  if (!_driverType) _driverType = resolveDriverType()
  return _driverType
}

/** 切换驱动类型（仅在 DEV 模式下生效）。
 *  仅负责切换类型标识 + 清空模块级单例引用；旧驱动实例的销毁由调用方
 *  （serial store 的 switchDriver）持有引用后统一处理。 */
export function setDriverType(type: DriverType): void {
  if (!import.meta.env.DEV) return
  _driverType = type
  _driver = null
}

/** 创建或获取当前驱动实例 */
export function createSerialDriver(): SerialDriver {
  if (_driver) return _driver
  const type = getDriverType()
  switch (type) {
    case 'serialport':
      _driver = new SerialPortDriver()
      break
    case 'webserial':
      _driver = new WebSerialDriver()
      break
    default:
      _driver = new MockSerialSource()
  }
  return _driver
}