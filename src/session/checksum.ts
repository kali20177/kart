import type { ChecksumConfig } from '@/types'
import { storage } from '@/composables/useStorage'

/** 旧版全局校验设置提取键（settings store 七次迁移写入，见 stores/settings.ts）。 */
export const LEGACY_CHECKSUM_KEY = 'legacy-checksum'

/**
 * 会话级校验配置的默认值。校验设置从全局移出后（多会话可各配各的），
 * 首次升级启动时以旧全局值播种，此后每个端口独立持久化、未配置的端口回归 'none'。
 */
export function defaultChecksumConfig(): ChecksumConfig {
  const legacy = storage.get<Partial<ChecksumConfig> | null>(LEGACY_CHECKSUM_KEY, null)
  return {
    send: legacy?.send ?? 'none',
    rx: legacy?.rx ?? 'none'
  }
}
