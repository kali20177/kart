/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<object, object, any>
  export default component
}

declare module 'vue-virtual-scroller'

declare const __APP_VERSION__: string
declare const __GIT_COMMIT__: string
declare const __BUILD_DATE__: string
declare const __DEP_VERSIONS__: Record<string, string>

// File System Access API 类型声明（TS lib 尚未覆盖新版 API）
interface FileSystemWritableFileStream {
  write(data: Uint8Array | ArrayBuffer): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle {
  name: string
  kind: 'directory'
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  queryPermission(descriptor: { mode: FileSystemPermissionMode }): Promise<FileSystemPermissionStatus>
  requestPermission(descriptor: { mode: FileSystemPermissionMode }): Promise<FileSystemPermissionStatus>
}

// Web Serial API（Chromium 89+ / Electron 31+ 内置，非标准 TS lib 包含）
interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialOptions {
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 1.5 | 2
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

// getSignals 可读的输入线（DCD/CTS/DSR/RI）
interface SerialInputSignals {
  dataCarrierDetect?: boolean
  clearToSend?: boolean
  dataSetReady?: boolean
  ringIndicator?: boolean
}

// setSignals 可写的输出线（DTR/RTS/Break）
interface SerialOutputSignals {
  dataTerminalReady?: boolean
  requestToSend?: boolean
  break?: boolean
}

interface SerialPort {
  getInfo(): SerialPortInfo
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getSignals(): Promise<SerialInputSignals>
  setSignals(signals: SerialOutputSignals): Promise<void>
  addEventListener(type: 'disconnect', listener: () => void): void
  removeEventListener(type: 'disconnect', listener: () => void): void
}

interface SerialPortRequestOptions {
  filters?: Array<{ usbVendorId?: number; usbProductId?: number }>
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>
}

// File System Access API（仅安全上下文可用）
interface Window {
  showSaveFilePicker?(options?: {
    suggestedName?: string
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }): Promise<FileSystemFileHandle & { name: string }>
  showDirectoryPicker?(options?: { id?: string }): Promise<FileSystemDirectoryHandle>
}

// 扩展 Navigator 以包含 Web Serial API（Chromium 89+）
interface Navigator {
  readonly serial: Serial
}
