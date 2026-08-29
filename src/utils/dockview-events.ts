import type { DockviewPanelApi } from 'dockview-vue'

/**
 * dockview 自定义 tab 与面板内容组件间的 refocus 事件。
 *
 * dockview 对「点击已激活面板的 tab」是 no-op：doSetActivePanel 提前 return，
 * 不重发 onDidActiveChange，内容组件的激活聚焦因此不跑，焦点会滞留在 .dv-tab
 * 上（随后 Enter 被 dockview tab 键盘处理吞掉、打字无效）。
 *
 * ViewTab 在点击已激活 tab 时广播本事件，面板内容组件按 api 对象同一性过滤后
 * 自行拉回输入焦点。document 总线与 CustomEvent detail 的机制细节收敛在本模块
 * （window 为 target 派发的事件不会流经 document 监听，故总线选 document），
 * 组件侧只见下面这对类型化函数，`import type` 保证 utils 无运行时框架依赖。
 */
export const VIEW_TAB_REACTIVATE = 'kart:view-tab-reactivate'

/** ViewTab 点击已激活 tab 时调用：广播 refocus 事件，detail 携带该面板 api。 */
export function emitViewTabReactivate(api: DockviewPanelApi): void {
  document.dispatchEvent(new CustomEvent(VIEW_TAB_REACTIVATE, { detail: api }))
}

/** 面板内容组件订阅 refocus：仅响应 detail === api 的事件（多面板共用总线）。
 *  返回解绑函数，onBeforeUnmount 时调用。 */
export function onViewTabReactivate(api: DockviewPanelApi, refocus: () => void): () => void {
  const handler = (e: Event): void => {
    if ((e as CustomEvent).detail === api) refocus()
  }
  document.addEventListener(VIEW_TAB_REACTIVATE, handler)
  return () => document.removeEventListener(VIEW_TAB_REACTIVATE, handler)
}
