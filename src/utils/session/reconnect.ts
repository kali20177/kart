/**
 * 自动重连调度 —— 纯函数（无定时器，可独立测试）。
 *
 * 复杂度集中在 serial store 的状态机里；这里只抽出不依赖框架的逻辑：
 *   - 根据「开关、上次选中端口、当前是否已连接」判断是否应当继续重连；
 *   - 计算下次尝试的时刻与给 UI 显示的倒计时秒数。
 *
 * 定时器本身、driver.open/close 仍留在 store；store 每次心跳调用 `tickReconnect`
 * 之外的判定入口（`shouldSchedule`）决定是否排程，`nextAttemptAt`/`countdownSecs`
 * 供组件渲染。
 */

export interface ReconnectDecision {
  /** 是否应排程下一次重连 */
  schedule: boolean
  /** 不应排程的原因（schedule=false 时，仅供日志/UI，可空） */
  reason?: 'disabled' | 'no-port' | 'connected'
}

/**
 * 是否应当发起一次自动重连。
 * @param enabled   设置中的 autoReconnect 开关
 * @param connected 当前是否已连接
 * @param lastPort  上次连接选中的端口（断了后要重连的目标）
 */
export function shouldReconnect(
  enabled: boolean,
  connected: boolean,
  lastPort: string | null
): ReconnectDecision {
  if (!enabled) return { schedule: false, reason: 'disabled' }
  if (connected) return { schedule: false, reason: 'connected' }
  if (!lastPort) return { schedule: false, reason: 'no-port' }
  return { schedule: true }
}

/**
 * 计算到下次重连的倒计时秒数（向上取整，最小 0）。
 * - now >= nextAt 时返回 0，表示「立即重试」。
 * - nextAt 为 null 时返回空串，表示未在重连。
 */
export function countdownSecs(now: number, nextAt: number | null): number {
  if (nextAt == null) return 0
  return Math.max(0, Math.ceil((nextAt - now) / 1000))
}