import { describe, it, expect } from 'vitest'
import { transportHintKey, formatConnectFailure } from './connect-hint'

describe('transportHintKey', () => {
  it('RTT/TCP 分别返回对应提示 key', () => {
    expect(transportHintKey('rtt')).toBe('transport.rttHint')
    expect(transportHintKey('tcp')).toBe('transport.tcpHint')
  })
  it('串口无提示（不追加横幅第二行）', () => {
    expect(transportHintKey('serial')).toBeNull()
  })
})

describe('formatConnectFailure', () => {
  it('有提示时换行追加到错误信息下方', () => {
    expect(formatConnectFailure('连接失败', '先启动 Server')).toBe('连接失败\n先启动 Server')
  })
  it('无提示时原样返回', () => {
    expect(formatConnectFailure('主机不能为空', null)).toBe('主机不能为空')
  })
})