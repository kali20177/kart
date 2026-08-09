import { inject, provide, ref, type InjectionKey, type Ref } from 'vue'
import type { Session } from '@/session'

/** 会话注入 key。Symbol 保证跨实例唯一，避免与字符串 key 冲突。 */
const SESSION_KEY: InjectionKey<Session> = Symbol('session')

/** 当前活动会话注入 key（全局区组件：MenuBar/命令面板）。注入的是 Ref，切 tab 时跟随。 */
const ACTIVE_SESSION_KEY: InjectionKey<Ref<Session>> = Symbol('active-session')

/** 被其他会话占用的端口集合注入 key（ConnectionBar 端口下拉禁用提示用）。 */
const OCCUPIED_PORTS_KEY: InjectionKey<Ref<ReadonlySet<string>>> = Symbol('occupied-ports')

/** 打开文件传输对话框回调注入 key（消息面板内 InputComposer 触发 → App.vue 根层渲染对话框）。 */
const OPEN_FILE_TRANSFER_KEY: InjectionKey<(file?: File) => void> = Symbol('open-file-transfer')

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
 * 提供当前活动会话（响应式 ref）。App.vue 在顶层调用一次，传入指向活动 tab
 * 会话的 computed/ref。全局区组件（MenuBar、QuickCommandsPanel）用 useActiveSession
 * 拿到 ref，再用 computed 派生出 serial/recorder 等——切 tab 时自动跟随活动会话。
 * （SettingsModal/FileTransferDialog 走 openerSession prop，不用此接口。）
 *
 * 注意：必须传入 ref/computed 本身而非 .value——provide 只在 setup 执行一次，
 * 传解包值会固定为调用那一刻的会话，切 tab 后全局组件仍指向旧会话。
 */
export function provideActiveSession(session: Ref<Session>): void {
  provide(ACTIVE_SESSION_KEY, session)
}

/** 获取当前活动会话 ref（全局区组件用）。必须在 provideActiveSession 的子树内调用。 */
export function useActiveSession(): Ref<Session> {
  const session = inject(ACTIVE_SESSION_KEY, null)
  if (!session) {
    throw new Error('useActiveSession() 必须在 provideActiveSession() 的组件子树内调用')
  }
  return session
}

/**
 * 提供被其他会话占用的端口集合。App.vue 在顶层调用一次，传入 computed；
 * ConnectionBar 用它禁用并标注被占用的端口。未提供（如单测环境）时为空集合。
 */
export function provideOccupiedPorts(ports: Ref<ReadonlySet<string>>): void {
  provide(OCCUPIED_PORTS_KEY, ports)
}

/** 获取被其他会话占用的端口集合（端口下拉禁用提示用）。未 provide 时返回空集合。 */
export function useOccupiedPorts(): Ref<ReadonlySet<string>> {
  return inject(OCCUPIED_PORTS_KEY, EMPTY_PORTS)
}

/**
 * 提供「打开文件传输对话框」回调。SessionPane 调用，传入绑定自身会话的 emit；
 * 消息面板组件（InputComposer 挂在其底部）经 useOpenFileTransfer 取用。
 * dockview 面板内容是动态渲染的，无法走组件 emit 链到 SessionPane，故用注入回调转发。
 */
export function provideOpenFileTransfer(fn: (file?: File) => void): void {
  provide(OPEN_FILE_TRANSFER_KEY, fn)
}

/** 获取「打开文件传输对话框」回调。未 provide（如单测）时返回 no-op。 */
export function useOpenFileTransfer(): (file?: File) => void {
  return inject(OPEN_FILE_TRANSFER_KEY, () => {})
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_PORTS: Ref<ReadonlySet<string>> = ref(EMPTY_SET)
