import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useSettingsStore } from './settings'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('settings store：默认值与持久化合并', () => {
  it('空存储时全部走默认值', () => {
    const store = useSettingsStore()
    expect(store.settings.encoding).toBe('utf-8')
    expect(store.settings.frame.gapMs).toBe(20)
    expect(store.settings.bufferLimit).toBe(5000)
    expect(store.settings.themeId).toBe('glass-industrial-dark')
    expect(store.settings.waveform.maxHistoryPoints).toBe(200_000)
    expect(store.settings.autoReconnect).toBe(false)
  })

  it('持久化值浅合并覆盖默认，未存字段不受影响', () => {
    localStorage.setItem('kart:settings', JSON.stringify({ encoding: 'gbk', bufferLimit: 123 }))
    const store = useSettingsStore()
    expect(store.settings.encoding).toBe('gbk')
    expect(store.settings.bufferLimit).toBe(123)
    // 未持久化字段仍回落默认
    expect(store.settings.frame.gapMs).toBe(20)
    expect(store.settings.themeId).toBe('glass-industrial-dark')
  })

  it('terminal 浅合并：旧配置只带个别字段时其余补默认', () => {
    localStorage.setItem('kart:settings', JSON.stringify({ terminal: { cols: 80 } }))
    const store = useSettingsStore()
    expect(store.settings.terminal.cols).toBe(80)
    expect(store.settings.terminal.rows).toBe(0)
    expect(store.settings.terminal.fontFamily).toBe('monospace')
  })
})

describe('settings store：legacy 迁移', () => {
  it('theme 旧字段迁移为 themeId（light→glass-industrial-light）并落盘', () => {
    localStorage.setItem('kart:settings', JSON.stringify({ theme: 'light' }))
    const store = useSettingsStore()
    expect(store.settings.themeId).toBe('glass-industrial-light')
    // 迁移结果同步写回存储
    const persisted = JSON.parse(localStorage.getItem('kart:settings')!)
    expect(persisted.themeId).toBe('glass-industrial-light')
    expect(persisted.theme).toBeUndefined()
  })

  it('waveform 缺 maxHistoryPoints 时回填默认', () => {
    localStorage.setItem('kart:settings', JSON.stringify({ waveform: { maxPoints: 100 } }))
    const store = useSettingsStore()
    expect(store.settings.waveform.maxPoints).toBe(100)
    expect(store.settings.waveform.maxHistoryPoints).toBe(200_000)
  })

  it('移除已废弃的二进制解析字段（format/type/littleEndian/byteOffset/sampleRate 等）', () => {
    localStorage.setItem(
      'kart:settings',
      JSON.stringify({
        waveform: { parse: { format: 'bin', littleEndian: true, legacy: 1 }, sampleRate: 44100 },
      })
    )
    const store = useSettingsStore()
    expect(store.settings.waveform.parse).toEqual({ legacy: 1 })
    expect('sampleRate' in store.settings.waveform).toBe(false)
  })
})

describe('settings store：autoSave 与 reset', () => {
  it('autoSave=false 时修改设置不落盘（开关本身仍持久化）', async () => {
    const store = useSettingsStore()
    store.autoSave = false
    await nextTick() // watch 默认 flush:'pre'，回调在下一 tick 执行
    expect(localStorage.getItem('kart:autoSave')).toBe('false')
    store.settings.encoding = 'gbk'
    await nextTick()
    expect(localStorage.getItem('kart:settings')).toBeNull()
  })

  it('autoSave=true 时修改设置即落盘', async () => {
    const store = useSettingsStore()
    store.settings.bufferLimit = 999
    await nextTick()
    const persisted = JSON.parse(localStorage.getItem('kart:settings')!)
    expect(persisted.bufferLimit).toBe(999)
  })

  it('reset 恢复全部默认值', () => {
    localStorage.setItem('kart:settings', JSON.stringify({ encoding: 'hex' }))
    const store = useSettingsStore()
    store.settings.encoding = 'gbk'
    store.settings.frame.gapMs = 100
    store.reset()
    expect(store.settings.encoding).toBe('utf-8')
    expect(store.settings.frame.gapMs).toBe(20)
    expect(store.settings.themeId).toBe('glass-industrial-dark')
  })
})