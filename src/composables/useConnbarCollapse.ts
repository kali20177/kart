import { effectScope, ref, watch, type EffectScope, type Ref } from 'vue'
import type { Session } from '@/session'
import { storage } from '@/composables/useStorage'

/**
 * 连接参数栏收起状态 —— ConnectionBar（面板内组件）与 SessionTab（dockview tab 渲染
 * 上下文，不在面板组件树内、拿不到面板级 inject）之间的共享状态。
 *
 * 状态本体按 session.id 存模块级注册表：同一会话无论多少组件调用本函数，拿到的是
 * 同一个 ref。持久化沿用旧语义：按端口各自记忆（未选端口回退 'default'），端口切换
 * 时重读、变更时落盘。watcher 跑在模块级 detached scope 里，不随组件卸载失效
 * （dockview 对 tab/面板内容的复用策略不保证组件存活，见 kart-module-top-side-effect
 * 教训的同类处理）；登记表条目与会话等命（数量个位字节级，不清理）。
 */
const COLLAPSED_KEY = (portKey: string) => `connbar:collapsed:${portKey}`

let scope: EffectScope | null = null
const registry = new Map<number, { collapsed: Ref<boolean> }>()

export function useConnbarCollapse(session: Session): { collapsed: Ref<boolean> } {
  const existing = registry.get(session.id)
  if (existing) return existing

  const collapsed = ref(storage.get(COLLAPSED_KEY(session.serial.selectedPort ?? 'default'), false))
  const portKey = () => session.serial.selectedPort ?? 'default'

  scope ??= effectScope(true)
  scope.run(() => {
    // 端口切换：重读新端口的持久化值（旧端口收起态不带到新端口）
    watch(portKey, (p) => {
      collapsed.value = storage.get(COLLAPSED_KEY(p), false)
    })
    // 收起态变更：按当前端口落盘
    watch(collapsed, (v) => {
      storage.set(COLLAPSED_KEY(portKey()), v)
    })
  })

  const entry = { collapsed }
  registry.set(session.id, entry)
  return entry
}
