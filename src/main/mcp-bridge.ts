import type { McpBridge } from '@/main/McpServer'

/** 主进程 → 渲染进程的工具调用请求载荷。 */
export interface ToolCallPayload {
  callId: number
  tool: string
  args: unknown
}

/** 渲染进程应答载荷（mcp:tool-result）。 */
export interface ToolResultPayload {
  callId: number
  ok: boolean
  result: unknown
}

/** call_tool 桥 + 应答路由（docs/mcp-design.md §八）。 */
export interface ToolCallBridge extends McpBridge {
  /** 渲染进程应答路由：callId 关联挂起调用；过期/未知 callId 静默丢弃并返回 false */
  resolveToolCall(payload: ToolResultPayload): boolean
  /** 当前 in-flight 调用数（测试观察用） */
  pendingCount(): number
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * call_tool 桥：callId 递增关联 pending promise，deliver 把请求真正发给
 * 渲染进程（发送失败/无窗口时返回 false，立即 reject）。
 *
 * - 并发：pending Map 支持多个 in-flight（AI 客户端常并发调工具）；
 * - 超时：deliver 后渲染端挂起 → 按注入超时 reject，不永久卡住调用；
 * - 过期丢弃：超时后才到达的应答（callId 已不在 pending）静默丢弃。
 */
export function createMcpBridge(
  deliver: (payload: ToolCallPayload) => boolean,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): ToolCallBridge {
  interface Pending {
    resolve: (result: unknown) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }
  const pending = new Map<number, Pending>()
  let nextCallId = 0

  return {
    invoke(tool, args) {
      return new Promise((resolve, reject) => {
        const callId = ++nextCallId
        const timer = setTimeout(() => {
          pending.delete(callId)
          reject(new Error(`mcp tool ${tool} 渲染进程无响应（${timeoutMs}ms 超时）`))
        }, timeoutMs)
        pending.set(callId, { resolve, reject, timer })

        let delivered = false
        try {
          delivered = deliver({ callId, tool, args })
        } catch (e) {
          clearTimeout(timer)
          pending.delete(callId)
          reject(e instanceof Error ? e : new Error(String(e)))
          return
        }
        if (!delivered) {
          clearTimeout(timer)
          pending.delete(callId)
          reject(new Error('无窗口：请先打开 Kart 主窗口'))
        }
      })
    },

    resolveToolCall(payload) {
      const p = pending.get(payload.callId)
      if (!p) return false
      clearTimeout(p.timer)
      pending.delete(payload.callId)
      if (payload.ok) p.resolve(payload.result)
      else p.reject(new Error(typeof payload.result === 'string' ? payload.result : String(payload.result)))
      return true
    },

    pendingCount() {
      return pending.size
    }
  }
}
