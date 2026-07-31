import { createSerialStore } from '@/stores/serial'
import { createMessagesStore } from '@/stores/messages'
import { createPauseStore } from '@/stores/pause'
import { createWaveformStore } from '@/stores/waveform'
import { createRecorderStore } from '@/stores/recorder'
import { createTransferStore } from '@/stores/transfer'
import { useSettingsStore } from '@/stores/settings'

/** 一个串口连接会话的全部状态。后续多 tab 时每个 tab 一个 Session 实例。 */
export interface Session {
  serial: ReturnType<typeof createSerialStore>
  messages: ReturnType<typeof createMessagesStore>
  pause: ReturnType<typeof createPauseStore>
  waveform: ReturnType<typeof createWaveformStore>
  recorder: ReturnType<typeof createRecorderStore>
  transfer: ReturnType<typeof createTransferStore>
}

/**
 * 创建一个自包含的串口会话：serial/messages/pause/waveform/recorder/transfer
 * 互相通过注入的 deps 接线，共享同一个全局 settings（编码/主题/波特率等跨会话统一）。
 *
 * 创建顺序严格遵循依赖关系：pause → messages → (回填 clearMessages) → serial →
 * waveform → (回填 clearWaveform) → recorder → transfer。
 *
 * 循环依赖（pause.clearAll 需要 messages.clear 与 waveform.clear）通过 closure
 * indirection 延迟绑定：先以空回调创建 pause，待目标 store 建好后回填真实引用。
 */
export function createSession(): Session {
  const s = useSettingsStore().settings

  // 延迟绑定器：pause.clearAll 在调用时才解析到真实的 clear 回调
  let _clearMessages: () => void = () => {}
  let _clearWaveform: () => void = () => {}

  const pause = createPauseStore({
    clearMessages: () => _clearMessages(),
    clearWaveform: () => _clearWaveform(),
  })

  const messages = createMessagesStore({
    settings: s,
    paused: pause.paused,
    pauseStartTime: pause.pauseStartTime,
    togglePause: () => pause.toggle(),
  })
  _clearMessages = () => messages.clear()

  const serial = createSerialStore({
    ingestRx: (bytes) => messages.ingestRx(bytes),
    addTx: (bytes, error) => messages.addTx(bytes, error),
    settings: s,
  })

  const waveform = createWaveformStore({
    onData: (cb) => serial.onData(cb),
    settings: s,
    paused: pause.paused,
    pauseStartTime: pause.pauseStartTime,
    togglePause: () => pause.toggle(),
  })
  _clearWaveform = () => waveform.clear()

  const recorder = createRecorderStore({
    onData: (cb) => serial.onData(cb),
    onTxData: (cb) => serial.onTxData(cb),
    connected: serial.connected,
    settings: s,
  })

  const transfer = createTransferStore({
    sendRaw: (bytes, record) => serial.sendRaw(bytes, record),
    onData: (cb) => serial.onData(cb),
    connected: serial.connected,
    addFileTransfer: (id, filename, size) => messages.addFileTransfer(id, filename, size),
  })

  return { serial, messages, pause, waveform, recorder, transfer }
}
