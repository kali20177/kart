import type { McpToolRegistry } from './registry'

/**
 * 把主进程 MCP 桥的 call_tool 请求接到渲染端工具注册表执行，应答回主进程。
 * 幂等初始化：重复调用只注册一次订阅（浏览器 dev / 单测无 window.electron.mcp 时 no-op）。
 */
export function initMcpToolBridge(registry: McpToolRegistry): () => void {
  const api = window.electron?.mcp
  if (!api) return () => {}
  return api.onToolCall(async ({ callId, tool, args }) => {
    try {
      const result = await registry.handle(tool, (args ?? {}) as Record<string, unknown>)
      await api.toolResult(callId, true, result ?? null)
    } catch (e) {
      await api.toolResult(callId, false, e instanceof Error ? e.message : String(e))
    }
  })
}
