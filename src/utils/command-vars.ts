// 快速命令占位符展开：发送时把 {time}/{time:full}/{seq}/{rand} 替换为动态值。
// 展开发生在模式转换（hex 解析 / ascii 编码）之前，因此占位符语义跟随模式：
//   {time}      HH:MM:SS（hex 模式展开为该字符串的 ASCII 十六进制）
//   {time:full} YYYY-MM-DD HH:MM:SS（hex 模式同上）
//   {seq}       自增序号：hex 模式单字节大写 hex（00-FF 取模）；ascii 模式十进制
//   {rand}      随机字节：hex 模式单字节大写 hex；ascii 模式十进制 0-255
// 未知的 {xxx} 占位符原样保留（普通载荷中的花括号不受影响）。
// 纯函数：时间/序号/随机源经 ctx 注入，便于单测确定展开结果。

import type { DataMode } from '@/types'

export interface CommandVarContext {
  /** 当前时间（默认 new Date()） */
  now?: Date
  /** 本次发送的序号（默认 1，配合 {seq}） */
  seq?: number
  /** 随机源返回 [0,1)，默认 Math.random（配合 {rand}） */
  random?: () => number
}

const VAR_RE = /\{time(?::full)?\}|\{seq\}|\{rand\}/gi

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** HH:MM:SS（本地时间） */
export function formatHms(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** YYYY-MM-DD HH:MM:SS（本地时间） */
export function formatFull(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHms(d)}`
}

/** 十进制转大写两位 hex；>255 取模 256（{seq}/{rand} 的 hex 形态恒为单字节） */
function hexByte(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0').toUpperCase()
}

/** 字符串的 ASCII 字节 → 连续大写 hex（hex 模式下时间类占位符的展开形式） */
function asciiToHex(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += hexByte(s.charCodeAt(i))
  return out
}

/** 展开占位符；未命中任何占位符时原样返回。 */
export function expandCommandVars(payload: string, mode: DataMode, ctx: CommandVarContext = {}): string {
  const now = ctx.now ?? new Date()
  const seq = ctx.seq ?? 1
  const random = ctx.random ?? Math.random

  return payload.replace(VAR_RE, (match) => {
    switch (match.toLowerCase()) {
      case '{time}': {
        const v = formatHms(now)
        return mode === 'hex' ? asciiToHex(v) : v
      }
      case '{time:full}': {
        const v = formatFull(now)
        return mode === 'hex' ? asciiToHex(v) : v
      }
      case '{seq}':
        return mode === 'hex' ? hexByte(seq) : String(seq)
      case '{rand}':
        return mode === 'hex' ? hexByte(Math.floor(random() * 256)) : String(Math.floor(random() * 256))
    }
    return match
  })
}