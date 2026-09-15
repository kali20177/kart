import { describe, it, expect } from 'vitest'
import './index' // 导入即注册全部内置解码器（与生产入口一致）
import { register, getDecoder, listDecoders } from './registry'
import { fieldDecoder } from './builtin/field'
import type { DecoderDefinition } from './types'

describe('decoder registry', () => {
  it('内置解码器已注册（导入 index 即注册）', () => {
    const ids = listDecoders().map((d) => d.id)
    expect(ids).toContain('field')
    expect(ids).toContain('modbus-rtu')
  })

  it('getDecoder 按 id 查找，未知 id 返回 undefined', () => {
    expect(getDecoder('field')?.name).toBe(fieldDecoder.name)
    expect(getDecoder('modbus-rtu')?.id).toBe('modbus-rtu')
    expect(getDecoder('no-such-decoder')).toBeUndefined()
  })

  it('register 覆盖同名注册项（镜像 themes 无重名保护），还原后内置项可用', () => {
    const fake: DecoderDefinition = { id: 'field', name: 'overridden', decode: () => ({ matched: false }) }
    register(fake)
    expect(getDecoder('field')?.name).toBe('overridden')
    register(fieldDecoder)
    expect(getDecoder('field')?.name).toBe(fieldDecoder.name)
  })

  it('modbus-rtu 声明自带 CRC16 校验（能力位，校验和弹窗冲突提示的数据源）', () => {
    const d = getDecoder('modbus-rtu')
    expect(d?.selfChecksIntegrity).toBe(true)
    expect(d?.integrityChecksum).toBe('crc16-modbus')
    // 字段布局解析器只是按布局切字节、从不校验，不应声明自带校验
    expect(fieldDecoder.selfChecksIntegrity).toBeUndefined()
  })
})
