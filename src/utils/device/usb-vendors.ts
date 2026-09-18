/**
 * USB VID → 厂商名反查表。
 *
 * Web Serial 只提供 usbVendorId/usbProductId，没有厂商字符串；serialport 自带
 * manufacturer。此表用于 Web Serial（及缺失 manufacturer 的其它来源）把 VID
 * 映射为可读名称，方便用户在端口下拉里分辨设备。只收录嵌入式调试常见的厂商，
 * 查不到的 VID 由调用方回退显示裸 ID。
 */
const VENDOR_NAMES: Record<string, string> = {
  '1a86': 'QinHeng Electronics (CH340/CH341)',
  '10c4': 'Silicon Labs (CP210x)',
  '0403': 'FTDI (FT232R/FT2232)',
  '067b': 'Prolific (PL2303)',
  '2341': 'Arduino',
  '239a': 'Adafruit',
  '0483': 'STMicroelectronics',
  '2e8a': 'Raspberry Pi (RP2040)',
  '303a': 'Espressif (ESP32)',
  '04d8': 'Microchip',
  '03eb': 'Atmel',
  '15a2': 'NXP / Freescale',
  '1366': 'SEGGER (J-Link)',
  '05c6': 'Qualcomm',
  '1d50': 'OpenMoko (Black Magic Probe)',
  '0bda': 'Realtek'
}

/**
 * 按 4 位小写 hex VID 查厂商名。入参形如 "1a86"（由驱动把 number 转 hex 后传入），
 * 查不到返回 undefined。
 */
export function lookupVendorName(vid: string): string | undefined {
  return VENDOR_NAMES[vid.toLowerCase()]
}

/** 把 USB VID/PID 数值统一格式化为 4 位 hex 字符串，如 6791 → "1a87"。 */
export function toHexId(n: number): string {
  return n.toString(16).padStart(4, '0')
}
