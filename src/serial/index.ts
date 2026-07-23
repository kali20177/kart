import type { SerialDriver } from '@/types'
import { WebSerialDriver } from './WebSerialDriver'
import { SerialPortDriver } from './SerialPortDriver'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { STORAGE_PREFIX } from '@/composables/useStorage'

export type DriverType = 'mock' | 'webserial' | 'serialport'

/**
 * 选择驱动类型，优先级：
 *  1. Electron 环境 → serialport（主进程串口库，返回真实 COM 口名）
 *  2. 开发模式 → 读取 localStorage 偏好，默认为 mock
 *  3. 浏览器环境（Web Serial API）→ webserial
 *  4. 兜底 → mock
 */
function resolveDriverType(): DriverType {
  // Electron 环境：始终使用 serialport（即使 dev 模式）
  const isElectron = typeof window !== 'undefined' && !!(window as any).electron?.serial
  if (isElectron) return 'serialport'

  // 开发模式：读取 localStorage 中的 driver 偏好，默认为 mock
  if (import.meta.env.DEV) {
    try {
      const stored = localStorage.getItem(STORAGE_PREFIX + 'driver')
      if (stored === 'webserial') return 'webserial'
    } catch { /* localStorage 不可用 */ }
    return 'mock'
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
 *  仅负责切换类型标识 + 落盘 + 清空模块级单例引用；旧驱动实例的销毁由调用方
 *  （serial store 的 switchDriver）持有引用后统一处理，避免在此处与调用方双重 destroy。 */
export function setDriverType(type: DriverType): void {
  if (!import.meta.env.DEV) return
  _driverType = type
  _driver = null
  try {
    localStorage.setItem(STORAGE_PREFIX + 'driver', type)
  } catch { /* ignore */ }
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