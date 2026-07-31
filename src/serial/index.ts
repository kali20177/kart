import type { SerialDriver } from '@/types'
import { WebSerialDriver } from './WebSerialDriver'
import { SerialPortDriver } from './SerialPortDriver'
import { MockSerialSource } from '@/mock/MockSerialSource'
import { UnsupportedDriver } from './UnsupportedDriver'
import { logger } from '@/utils/logger'

export type DriverType = 'mock' | 'webserial' | 'serialport' | 'unsupported'
export type UnsupportedReason = 'insecure-context' | 'no-web-serial'

interface ResolveEnv {
  isElectron: boolean
  /** DEV 模式下带 ?mock 查询参数 */
  isDevMock: boolean
  isSecureContext: boolean
  hasWebSerial: boolean
}

interface ResolveResult {
  type: DriverType
  /** 仅当 type === 'unsupported' 时非 null */
  reason: UnsupportedReason | null
}

/**
 * 驱动类型判定(纯函数,便于单测)。优先级:
 *  1. Electron 环境 -> serialport(主进程串口库,返回真实 COM 口名)
 *  2. DEV 模式 ?mock 查询参数 -> mock(开发者调试用,不暴露给普通用户)
 *  3. 非安全上下文 -> unsupported(insecure-context)
 *       Web Serial 仅在安全上下文暴露,非安全下 navigator.serial 本就 undefined;
 *       先判安全上下文,可给 Chrome+http 用户精准的「改用 HTTPS」提示,而非「换浏览器」。
 *  4. 浏览器环境(Web Serial API 存在)-> webserial
 *  5. 兜底 -> unsupported(no-web-serial)
 *
 * 注意:不再兜底 mock。mock 仅 DEV+?mock 可用;不兼容时由 UI 层全屏遮罩引导用户
 * 切换/升级浏览器,避免普通用户误把模拟数据当成真实串口流量。
 */
export function resolveDriverType(env: ResolveEnv): ResolveResult {
  if (env.isElectron) return { type: 'serialport', reason: null }
  if (env.isDevMock) return { type: 'mock', reason: null }
  if (!env.isSecureContext) return { type: 'unsupported', reason: 'insecure-context' }
  if (env.hasWebSerial) return { type: 'webserial', reason: null }
  return { type: 'unsupported', reason: 'no-web-serial' }
}

/** 从当前运行环境收集判定入参 */
function collectEnv(): ResolveEnv {
  const isElectron = typeof window !== 'undefined' && !!window.electron?.serial

  let isDevMock = false
  if (import.meta.env.DEV) {
    try {
      const params = new URLSearchParams(window.location.search)
      isDevMock = params.has('mock')
    } catch { /* SSR / 无 window 环境 */ }
  }

  const isSecureContext = typeof window !== 'undefined' ? window.isSecureContext : false
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator

  return { isElectron, isDevMock, isSecureContext, hasWebSerial }
}

let _resolved: ResolveResult | null = null

function getResolved(): ResolveResult {
  if (!_resolved) {
    _resolved = resolveDriverType(collectEnv())
    logger.info('serial', `driver resolved: ${_resolved.type}${_resolved.reason ? ` (${_resolved.reason})` : ''}`)
  }
  return _resolved
}

/** 获取当前驱动类型 */
export function getDriverType(): DriverType {
  return getResolved().type
}

/** 获取不兼容原因(仅当 driverType === 'unsupported' 时非 null) */
export function getUnsupportedReason(): UnsupportedReason | null {
  return getResolved().reason
}

/** 切换驱动类型(仅在 DEV 模式下生效)。
 *  仅负责切换类型标识 + 清空模块级单例引用;旧驱动实例的销毁由调用方
 *  (serial store 的 switchDriver)持有引用后统一处理。 */
export function setDriverType(type: DriverType): void {
  if (!import.meta.env.DEV) return
  _resolved = { type, reason: null }
  _driver = null
  logger.info('serial', `driver switched (DEV): ${type}`)
}

let _driver: SerialDriver | null = null

/** 按驱动类型创建实例（无缓存）。per-session 路径与测试用。 */
export function createDriverOfType(type: DriverType): SerialDriver {
  switch (type) {
    case 'serialport':
      return new SerialPortDriver()
    case 'webserial':
      return new WebSerialDriver()
    case 'mock':
      return new MockSerialSource()
    default:
      return new UnsupportedDriver()
  }
}

/** 创建当前环境类型的新驱动实例（无缓存）——每个会话一个独立实例。 */
export function createFreshSerialDriver(): SerialDriver {
  return createDriverOfType(getDriverType())
}

/** 创建或获取当前驱动实例（模块级缓存） */
export function createSerialDriver(): SerialDriver {
  if (_driver) return _driver
  _driver = createDriverOfType(getDriverType())
  return _driver
}
