// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createMcpBridge, type ToolCallPayload } from './mcp-bridge'

describe('createMcpBridge（call_tool 桥，docs/mcp-design.md §八）', () => {
  it('正常应答：deliver 后 resolveToolCall 带回结果', async () => {
    const delivered: ToolCallPayload[] = []
    const bridge = createMcpBridge((p) => {
      delivered.push(p)
      return true
    })
    const p = bridge.invoke('send_string', { a: 1 })
    expect(bridge.pendingCount()).toBe(1)
    expect(delivered[0].tool).toBe('send_string')

    expect(bridge.resolveToolCall({ callId: delivered[0].callId, ok: true, result: { ok: true } })).toBe(true)
    await expect(p).resolves.toEqual({ ok: true })
    expect(bridge.pendingCount()).toBe(0)
  })

  it('并发 in-flight：乱序应答各回各的调用', async () => {
    const delivered: ToolCallPayload[] = []
    const bridge = createMcpBridge((p) => {
      delivered.push(p)
      return true
    })
    const p1 = bridge.invoke('tool_a', { x: 1 })
    const p2 = bridge.invoke('tool_b', {})
    const p3 = bridge.invoke('tool_c', {})
    expect(bridge.pendingCount()).toBe(3)

    // 乱序应答：C → A → B(失败)
    bridge.resolveToolCall({ callId: delivered[2].callId, ok: true, result: 'c' })
    bridge.resolveToolCall({ callId: delivered[0].callId, ok: true, result: 'a' })
    bridge.resolveToolCall({ callId: delivered[1].callId, ok: false, result: 'b 失败' })

    await expect(p1).resolves.toBe('a')
    await expect(p2).rejects.toThrow('b 失败')
    await expect(p3).resolves.toBe('c')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('渲染端挂起 → 超时 reject，pending 清空', async () => {
    const bridge = createMcpBridge(() => true, 30)
    await expect(bridge.invoke('list_sessions', {})).rejects.toThrow('超时')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('超时后才到达的应答（过期 callId）静默丢弃', async () => {
    const delivered: ToolCallPayload[] = []
    const bridge = createMcpBridge((p) => {
      delivered.push(p)
      return true
    }, 20)
    await expect(bridge.invoke('tool_a', {})).rejects.toThrow('超时')
    expect(bridge.resolveToolCall({ callId: delivered[0].callId, ok: true, result: 'late' })).toBe(false)
    expect(bridge.pendingCount()).toBe(0)
  })

  it('deliver 返回 false（无窗口）→ 立即 reject 且不挂 pending', async () => {
    const bridge = createMcpBridge(() => false)
    await expect(bridge.invoke('tool_a', {})).rejects.toThrow('无窗口')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('deliver 抛错（webContents 销毁）→ reject 该错误', async () => {
    const bridge = createMcpBridge(() => {
      throw new Error('webContents destroyed')
    })
    await expect(bridge.invoke('tool_a', {})).rejects.toThrow('webContents destroyed')
    expect(bridge.pendingCount()).toBe(0)
  })
})
