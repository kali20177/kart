import { describe, it, expect } from 'vitest'
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '@/mcp/contract'

describe('MCP 工具契约', () => {
  it('工具名全局唯一（MCP list_tools 要求）', () => {
    const names = MCP_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('MCP_TOOL_BY_NAME 索引与列表一致', () => {
    expect(MCP_TOOL_BY_NAME.size).toBe(MCP_TOOLS.length)
    for (const t of MCP_TOOLS) expect(MCP_TOOL_BY_NAME.get(t.name)).toBe(t)
  })

  it('每个工具都有可读的 description 与 zod shape inputSchema', () => {
    for (const t of MCP_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(20)
      expect(t.inputSchema).toBeTypeOf('object')
    }
  })

  it('写工具必须显式 write 标记（read-only 模式 gate 依赖它）', () => {
    const writeTools = MCP_TOOLS.filter((t) => t.write).map((t) => t.name)
    // 连接/发送/会话控制全为写；纯读取不带 write
    expect(writeTools).toEqual(
      expect.arrayContaining([
        'connect_serial',
        'disconnect',
        'send_bytes',
        'send_string',
        'run_quick_command',
        'set_paused',
        'clear_messages'
      ])
    )
    for (const t of MCP_TOOLS) expect(typeof t.write).toBe('boolean')
  })

  it('读工具可被只读模式全部覆盖', () => {
    const readTools = MCP_TOOLS.filter((t) => !t.write)
    expect(readTools.length).toBeGreaterThanOrEqual(7)
    for (const t of readTools) expect(t.write).toBe(false)
  })
})
