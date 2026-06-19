// 静态 ASCII 对照表数据（0-127）

export interface AsciiEntry {
  dec: number
  hex: string
  oct: string
  /** 可打印字符；控制字符为 null */
  char: string | null
  /** 控制字符缩写名（如 NUL/CR/LF）；可打印字符为其本身 */
  name: string
  /** 常见转义写法（如 \n \r \t \0），无则 undefined */
  escape?: string
  /** 是否为控制字符（0-31, 127） */
  control: boolean
}

const CONTROL_NAMES: string[] = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'
]

const ESCAPES: Record<number, string> = {
  0: '\\0',
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r'
}

function buildTable(): AsciiEntry[] {
  const table: AsciiEntry[] = []
  for (let dec = 0; dec < 128; dec++) {
    const control = dec < 32 || dec === 127
    const char = !control ? String.fromCharCode(dec) : null
    let name: string
    if (dec < 32) name = CONTROL_NAMES[dec]
    else if (dec === 127) name = 'DEL'
    else if (dec === 32) name = 'SP (空格)'
    else name = char as string
    table.push({
      dec,
      hex: dec.toString(16).padStart(2, '0').toUpperCase(),
      oct: dec.toString(8).padStart(3, '0'),
      char,
      name,
      escape: ESCAPES[dec],
      control
    })
  }
  return table
}

export const ASCII_TABLE: AsciiEntry[] = buildTable()
