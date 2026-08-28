import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import type { AppSettings, WaveformSettings } from '@/types'
import { storage } from '@/composables/useStorage'
import { persistNow } from '@/utils/persist'
import { migrateLegacyThemeFields } from '@/themes'

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
  themeOverrides: {},
  fontSize: 13,
  locale: 'zh-CN',
  waveform: {
    parse: {},
    maxPoints: 5000,
    maxHistoryPoints: 200_000
  },
  terminal: {
    cols: 0,
    rows: 0,
    fontScale: 1,
    transmitMode: 'char' as const,
    echo: false,
    backspace: 'del' as const,
    lineEnding: 'cr' as const,
    scrollbackLimit: 5000,
    fontFamily: 'monospace'
  },
  autoReconnect: false,
  showPauseNotification: true,
  recordFormat: 'text' as const,
  sendHistoryLimit: 50,
}

/** 全局共享 store：应用设置跨会话统一（组件经 session.settings 或单例均可读同一 proxy）。 */
export const useSettingsStore = defineStore('settings', () => {
  // 从存储读取持久化数据
  const persisted = storage.get<
    Partial<AppSettings> & {
      theme?: string
      themeMode?: string
    }
  >('settings', {})

  // 主题字段迁移（theme→themeId / themeMode→themeId / 未知 id 回退暗色），
  // 与 main.ts 首帧共用 migrateLegacyThemeFields 唯一实现
  if (migrateLegacyThemeFields(persisted as Record<string, unknown>)) {
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

  // terminal 浅合并兜底：persisted 若有旧值会整体覆盖 DEFAULTS.terminal，缺字段时补默认
  settings.terminal = { ...DEFAULTS.terminal, ...settings.terminal }

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
