import { defineStore } from 'pinia'
import { reactive, watch } from 'vue'
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
  autoReconnect: false
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = reactive<AppSettings>(
    structuredClone({ ...DEFAULTS, ...storage.get('settings', {}) })
  )

  // 任何变更落盘
  watch(
    settings,
    (val) => storage.set('settings', val),
    { deep: true }
  )

  function reset() {
    Object.assign(settings, structuredClone(DEFAULTS))
  }

  return { settings, reset }
})
