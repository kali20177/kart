import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import type { AppSettings } from '@/types'
import { storage } from '@/composables/useStorage'

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
  theme: 'dark',
  fontSize: 13,
  locale: 'zh-CN',
  waveform: {
    parse: {
      type: 'int16',
      littleEndian: true,
      channels: 2,
      byteOffset: 0
    },
    sampleRate: 640,
    maxPoints: 5000
  },
  autoReconnect: false,
  showPauseNotification: true
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = reactive<AppSettings>(
    structuredClone({ ...DEFAULTS, ...storage.get('settings', {}) })
  )

  // 是否自动把配置落盘（菜单「文件 ▸ 自动保存配置」开关）。
  // 开关标志本身始终持久化；它只决定 settings 内容是否自动写入本地存储。
  const autoSave = ref<boolean>(storage.get('autoSave', true))
  watch(autoSave, (on) => {
    storage.set('autoSave', on)
    if (on) storage.set('settings', settings) // 开启时立即落盘当前配置
  })

  // 任何变更落盘（受 autoSave 开关控制）
  watch(
    settings,
    (val) => {
      if (autoSave.value) storage.set('settings', val)
    },
    { deep: true }
  )

  function reset() {
    Object.assign(settings, structuredClone(DEFAULTS))
  }

  return { settings, autoSave, reset }
})
