import type { SerialDriver } from '@/types'
import { WebSerialDriver } from './WebSerialDriver'
import { MockSerialSource } from '@/mock/MockSerialSource'

export type DriverType = 'mock' | 'webserial'

/**
 * 选择驱动类型：
 * - 开发模式默认使用 Mock（可通过 localStorage 切换）
 * - 生产/非开发模式使用 Web Serial
 */
function resolveDriverType(): DriverType {
  if (import.meta.env.DEV) {
    // 开发模式：读取 localStorage 中的 driver 偏好，默认为 mock
    try {
      const stored = localStorage.getItem('serial-demo:driver')
      if (stored === 'webserial') return 'webserial'
    } catch { /* localStorage 不可用 */ }
    return 'mock'
  }
  return 'webserial'
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
    localStorage.setItem('serial-demo:driver', type)
  } catch { /* ignore */ }
}

/** 创建或获取当前驱动实例 */
export function createSerialDriver(): SerialDriver {
  if (_driver) return _driver
  const type = getDriverType()
  _driver = type === 'webserial' ? new WebSerialDriver() : new MockSerialSource()
  return _driver
}
