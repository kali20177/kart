/**
 * 直通模式底部提示的展示形态选择（纯函数，便于单测）。
 *
 * 提示只在 TCP 传输下渲染：TCP 对端（如 nc / 裸 socket 服务器）常无回显，
 * 本地回显关闭时按键虽已发送但屏幕不可见，必须警示并给出去向（工具栏「回显」开关）；
 * 本地回显开启或未连接时给中性说明。串口设备通常回显按键、无回显歧义，不占提示位（hidden）。
 */
export type CharHintKind = 'hidden' | 'needConnect' | 'echoOn' | 'tcpNoEcho'

export function resolveCharHintKind(connected: boolean, echo: boolean, isTcp: boolean): CharHintKind {
  if (!isTcp) return 'hidden'
  if (!connected) return 'needConnect'
  return echo ? 'echoOn' : 'tcpNoEcho'
}
