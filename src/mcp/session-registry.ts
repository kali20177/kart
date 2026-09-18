import type { Session } from '@/session'

/**
 * 全局会话注册表——MCP 工具枚举/路由会话的唯一入口。
 *
 * 为什么需要它：会话经 `useSession()`/`useSessions()` 以组件树 provide 下发，
 * 模块级的 MCP registry 拿不到；注册表以模块级 Map 承接 App.vue 创建的会话，
 * 供 `list_sessions` 与 sessionId 路由使用（docs/mcp-design.md §八）。
 */
export interface McpSessionRegistry {
  register(session: Session): void
  unregister(id: number): void
  list(): Session[]
  get(id: number): Session | undefined
}

export function createSessionRegistry(): McpSessionRegistry {
  const sessions = new Map<number, Session>()
  return {
    register(session) {
      sessions.set(session.id, session)
    },
    unregister(id) {
      sessions.delete(id)
    },
    list() {
      return [...sessions.values()]
    },
    get(id) {
      return sessions.get(id)
    }
  }
}

/** 渲染进程默认实例（App.vue 接入；测试用 createSessionRegistry 自建实例）。 */
export const mcpSessionRegistry = createSessionRegistry()
