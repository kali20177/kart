import { defineStore, storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { createMessagesStore } from '@/stores/messages'
import { createPauseStore } from '@/stores/pause'
import { createWaveformStore } from '@/stores/waveform'
import { createSerialStore } from '@/stores/serial'
import { DEFAULT_DECODER_CONFIG } from '@/decoders'
import { defaultChecksumConfig } from '@/session/checksum'
import { createSerialDriver } from '@/serial'

/**
 * 全局单例（测试与兼容用）。生产代码经 useSession() 取会话内实例，勿直接调用。
 *
 * 单例集中于此而非各自 factory 文件的原因：store 之间互相通过 deps 接线
 * （见 session/index.ts 的组合根），若把单例留在 factory 文件里，
 * pause↔messages↔waveform↔serial 会互相顶层 import 形成循环依赖。
 * 把互相引用的接线收敛在同一个模块，factory 文件保持叶子地位。
 */

/** 消息 store 单例。暂停与消息共享同一全局 paused（原注释见 stores/messages.ts）。 */
export const useMessagesStore = defineStore('messages', () => {
  const s = useSettingsStore()
  const p = usePauseStore()
  const { paused, pauseStartTime } = storeToRefs(p)
  return createMessagesStore({
    settings: s.settings,
    // 单例无会话上下文：校验/帧解码保持默认（生产经 session 注入按端口配置）
    checksum: defaultChecksumConfig(),
    decoder: structuredClone(DEFAULT_DECODER_CONFIG),
    paused,
    pauseStartTime,
    togglePause: () => p.toggle(),
  })
})

/** 暂停 store 单例。dashboard 无全局单例（仅会话内），clearDashboard 在此为 no-op。 */
export const usePauseStore = defineStore('pause', () =>
  createPauseStore({
    clearMessages: () => useMessagesStore().clear(),
    clearWaveform: () => useWaveformStore().clear(),
    clearDashboard: () => {},
  })
)

/** 波形 store 单例。订阅串口单例的原始字节流，暂停与清空来自 pause 单例。 */
export const useWaveformStore = defineStore('waveform', () => {
  const serial = useSerialStore()
  const s = useSettingsStore()
  const p = usePauseStore()
  const { paused, pauseStartTime } = storeToRefs(p)
  return createWaveformStore({
    onData: (cb) => serial.onData(cb),
    settings: s.settings,
    paused,
    pauseStartTime,
    togglePause: () => p.toggle(),
  })
})

/** 串口 store 单例。RX/TX 帧写入委托给消息单例，自动重连开关来自全局设置。 */
export const useSerialStore = defineStore('serial', () => {
  const m = useMessagesStore()
  const s = useSettingsStore()
  return createSerialStore({
    ingestRx: (bytes) => m.ingestRx(bytes),
    addTx: (bytes, error) => m.addTx(bytes, error),
    settings: s.settings,
    createDriver: () => createSerialDriver(),
  })
})