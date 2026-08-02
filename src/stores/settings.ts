import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import type { AppSettings, WaveformSettings } from '@/types'
import { storage } from '@/composables/useStorage'
import { persistNow } from '@/utils/persist'
import { getTheme } from '@/themes'

const DEFAULTS: AppSettings = {
  encoding: 'utf-8',
  frame: {
    strategy: 'gap-timeout',
    gapMs: 20,
    delimiterHex: '0D0A',
    fixedLength: 8
  },
  bufferLimit: 5000,
  defaultView: 'ascii',
  themeId: 'glass-industrial-dark',
  fontSize: 13,
  locale: 'zh-CN',
  waveform: {
    parse: {},
    maxPoints: 5000,
    maxHistoryPoints: 200_000
  },
  autoReconnect: false,
  showPauseNotification: true,
  recordFormat: 'text' as const,
  sendChecksum: 'none',
  rxChecksumAlgorithm: 'none'
}

/** 全局共享 store：应用设置跨会话统一（组件经 session.settings 或单例均可读同一 proxy）。 */
export const useSettingsStore = defineStore('settings', () => {
  // 从存储读取持久化数据
  // 注：rxVerifyChecksum 为已废弃旧字段（迁移后删除），仅读取时保留以做迁移
  const persisted = storage.get<Partial<AppSettings & { theme?: string; themeMode?: string; rxVerifyChecksum?: boolean }>>('settings', {})

  // 迁移：旧版 theme → themeId
  if ('theme' in persisted) {
    const old = persisted.theme
    persisted.themeId = old === 'light' ? 'glass-industrial-light' : ('glass-industrial-dark' as string)
    delete persisted.theme
    persistNow('settings', persisted)
  }
  // 二次迁移：上一版 themeMode（已被删除）→ glass-industrial 对应主题
  if ('themeMode' in persisted && !('themeId' in persisted)) {
    persisted.themeId = persisted.themeMode === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    delete persisted.themeMode
    persistNow('settings', persisted)
  }
  // 三次迁移：上一轮 themeId='glass-industrial'（无 dark/light 后缀）→ 暗色
  if (persisted.themeId && !getTheme(persisted.themeId)) {
    persisted.themeId = 'glass-industrial-dark'
    persistNow('settings', persisted)
  }
  // 四次迁移：rxVerifyChecksum 开关已废弃，改用 rxChecksumAlgorithm='none' 表示关闭。
  // 旧版以 sendChecksum 兼作 RX 校验算法，故开启校验的用户沿用其 sendChecksum 作为 RX 算法。
  if ('rxVerifyChecksum' in persisted) {
    if (persisted.rxVerifyChecksum && !('rxChecksumAlgorithm' in persisted)) {
      persisted.rxChecksumAlgorithm = (persisted.sendChecksum && persisted.sendChecksum !== 'none')
        ? persisted.sendChecksum
        : 'none'
    }
    delete persisted.rxVerifyChecksum
    persistNow('settings', persisted)
  }
  // 五次迁移：waveform 新增 maxHistoryPoints（历史缓冲上限）。浅合并下 persisted.waveform
  // 整体覆盖 DEFAULTS.waveform，旧数据缺该字段需显式补默认，否则 maxHistoryPoints 为 undefined。
  // 注：persisted.waveform 经 storage 读回，内部字段实际可能缺失，故 cast 为 Partial 再判空。
  const persistedWf = persisted.waveform as Partial<WaveformSettings> | undefined
  if (persistedWf && persistedWf.maxHistoryPoints == null) {
    persistedWf.maxHistoryPoints = DEFAULTS.waveform.maxHistoryPoints
    persistNow('settings', persisted)
  }
  // 六次迁移：移除二进制解析模式。旧数据可能残留 format/type/littleEndian/
  // byteOffset/sampleRate/channels 字段，清理以保持整洁。
  if (persistedWf) {
    const parse = persistedWf.parse as Record<string, unknown> | undefined
    let dirty = false
    if (parse) {
      for (const k of ['format', 'type', 'littleEndian', 'byteOffset', 'channels']) {
        if (k in parse) { delete parse[k]; dirty = true }
      }
    }
    if ('sampleRate' in (persistedWf as Record<string, unknown>)) {
      delete (persistedWf as Record<string, unknown>).sampleRate
      dirty = true
    }
    if (dirty) persistNow('settings', persisted)
  }

  const settings = reactive<AppSettings>(
    structuredClone({ ...DEFAULTS, ...persisted })
  )

  // 是否自动把配置落盘（菜单「文件 ▸ 自动保存配置」开关）。
  // 开关标志本身始终持久化；它只决定 settings 内容是否自动写入本地存储。
  const autoSave = ref<boolean>(storage.get('autoSave', true))
  watch(autoSave, (on) => {
    persistNow('autoSave', on)
    if (on) persistNow('settings', settings) // 开启时立即落盘当前配置
  })

  // 任何变更落盘（受 autoSave 开关控制）
  watch(
    settings,
    (val) => {
      if (autoSave.value) persistNow('settings', val)
    },
    { deep: true }
  )

  function reset() {
    Object.assign(settings, structuredClone(DEFAULTS))
  }

  return { settings, autoSave, reset }
})
