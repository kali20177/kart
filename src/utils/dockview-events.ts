/**
 * dockview 自定义 tab 与面板内容组件间的 refocus 事件。
 *
 * dockview 对「点击已激活面板的 tab」是 no-op：doSetActivePanel 提前 return，
 * 不重发 onDidActiveChange，内容组件的激活聚焦因此不跑，焦点会滞留在 .dv-tab
 * 上（随后 Enter 被 dockview tab 键盘处理吞掉、打字无效）。
 *
 * ViewTab 在点击已激活 tab 时广播本事件（detail = 该面板的 DockviewPanelApi），
 * 面板内容组件按 api 对象同一性过滤后自行拉回输入焦点。
 */
export const VIEW_TAB_REACTIVATE = 'kart:view-tab-reactivate'
