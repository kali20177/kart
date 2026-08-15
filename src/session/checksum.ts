import type { ChecksumConfig } from '@/types'

/**
 * 会话级校验配置的默认值。校验设置从全局移出后（多会话可各配各的），
 * 每个端口独立持久化，未配置的端口回归该默认（'none'，不启用校验）。
 */
export function defaultChecksumConfig(): ChecksumConfig {
  return { send: 'none', rx: 'none' }
}
