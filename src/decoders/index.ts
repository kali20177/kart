// 解码器模块入口：导入即注册全部内置解码器（镜像 themes/index.ts 模式）。
import { register } from './registry'
import { fieldDecoder } from './builtin/field'
import { modbusRtuDecoder } from './builtin/modbus-rtu'
import type { DecoderConfig } from './types'

register(fieldDecoder)
register(modbusRtuDecoder)

/**
 * 会话级解码器配置默认值。enabled=false：默认不改变任何现有行为。
 * 默认选项内置一套与 mock「二进制连续帧」（AA 55 len payload xor）匹配的起步模板，
 * 用户启用后即可见效果，再按需增删字段。
 */
export const DEFAULT_DECODER_CONFIG: DecoderConfig = {
  enabled: false,
  id: 'field',
  options: {
    header: 'AA55',
    fields: [
      { name: 'header', length: 2, format: 'hex' },
      { name: 'len', length: 1, format: 'u8' },
      { name: 'payload', length: 6, format: 'hex' },
      { name: 'crc', length: 1, format: 'hex' }
    ]
  }
}

export { register, getDecoder, listDecoders } from './registry'
export type {
  DecoderDefinition,
  DecodeResult,
  DecodeField,
  DecodeInfo,
  DecoderConfig,
  FieldFormat,
  FieldDef,
  FieldDecoderOptions
} from './types'
