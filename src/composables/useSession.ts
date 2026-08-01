import { inject, provide, type InjectionKey } from 'vue'
import type { Session } from '@/session'

/** 会话注入 key。Symbol 保证跨实例唯一，避免与字符串 key 冲突。 */
const SESSION_KEY: InjectionKey<Session> = Symbol('session')

/** 当前活动会话注入 key（全局区组件：MenuBar/命令面板/根层对话框）。 */
const ACTIVE_SESSION_KEY: InjectionKey<Session> = Symbol('active-session')

/**
 * 提供当前组件子树使用的会话。SessionPane 为每个 tab 调用一次，传入对应会话。
 */
export function provideSession(session: Session): void {
  provide(SESSION_KEY, session)
}

/**
 * 获取当前会话（组件内替代 useXxxStore 全局单例）。
 * 必须在 provideSession 的子树内调用，否则抛出明确错误——防止在根组件外
 * （无会话上下文）误用导致静默拿到 undefined。
 */
export function useSession(): Session {
  const session = inject(SESSION_KEY, null)
  if (!session) {
    throw new Error('useSession() 必须在 provideSession() 的组件子树内调用')
  }
  return session
}

/**
 * 提供当前活动会话（App.vue 在顶层调用一次）。全局区组件（MenuBar、
 * QuickCommandsPanel、SettingsModal、FileTransferDialog）用 useActiveSession
 * 获取当前活动 tab 的会话；会话区块内组件仍用 useSession 取本 tab 会话。
 */
export function provideActiveSession(session: Session): void {
  provide(ACTIVE_SESSION_KEY, session)
}

/** 获取当前活动会话（全局区组件用）。必须在 provideActiveSession 的子树内调用。 */
export function useActiveSession(): Session {
  const session = inject(ACTIVE_SESSION_KEY, null)
  if (!session) {
    throw new Error('useActiveSession() 必须在 provideActiveSession() 的组件子树内调用')
  }
  return session
}
