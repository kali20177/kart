import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue'
import type { DropdownOption } from 'naive-ui'
import type { DockviewGroupPanel } from 'dockview-vue'

/** 视图「＋」菜单注入 key（ViewAddAction 触发 → SessionPane 添加/激活视图面板）。 */
const VIEW_ADD_MENU_KEY: InjectionKey<{
  /** 菜单选项（含 ✓ 已打开 / ＋ 未打开 标记），由 SessionPane 按布局响应式构造 */
  options: ComputedRef<DropdownOption[]>
  /** 选中回调：key 为视图面板 id；group 为按钮所在 tab 条组——并排分栏时新视图落该组 */
  select: (key: string, group?: DockviewGroupPanel) => void
}> = Symbol('view-add-menu')

/**
 * 提供「添加/聚焦视图」菜单。SessionPane 调用一次，传入菜单选项与选中回调；
 * 视图 tab 条的＋按钮（ViewAddAction，由 dockview 渲染、无法走 emit 链）经注入取用，
 * 与 useSession 的注入回调模式一致。
 */
export function provideViewAddMenu(menu: {
  options: ComputedRef<DropdownOption[]>
  select: (key: string, group?: DockviewGroupPanel) => void
}): void {
  provide(VIEW_ADD_MENU_KEY, menu)
}

/** 获取「添加/聚焦视图」菜单。未 provide（如单测）时为空选项 + no-op。 */
export function useViewAddMenu(): {
  options: ComputedRef<DropdownOption[]>
  select: (key: string, group?: DockviewGroupPanel) => void
} {
  return inject(VIEW_ADD_MENU_KEY, { options: computed(() => []), select: () => {} })
}
