import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { QuickCommand } from '@/types'
import { storage } from '@/composables/useStorage'
import { persistNow } from '@/utils/persist'

/** 内置示例命令，便于阶段 1 演示 */
const PRESETS: QuickCommand[] = [
  { id: 'p1', name: '握手', payload: 'AT', mode: 'ascii', appendNewline: 'crlf', color: '#36ad6a' },
  { id: 'p2', name: '信号质量', payload: 'AT+CSQ', mode: 'ascii', appendNewline: 'crlf', color: '#2080f0' },
  { id: 'p3', name: '厂商', payload: 'AT+CGMI', mode: 'ascii', appendNewline: 'crlf', color: '#2080f0' },
  { id: 'p4', name: '固件版本', payload: 'AT+GMR', mode: 'ascii', appendNewline: 'crlf', color: '#2080f0' },
  { id: 'p5', name: '查询帧', payload: 'AA 55 02 01 00 03', mode: 'hex', appendNewline: 'none', color: '#f0a020' },
  // 占位符示例：发送时 {time:full} 展开为当前本地时间，如 SET_TIME=2026-08-18 09:05:07
  { id: 'p6', name: '校时示例', payload: 'SET_TIME={time:full}', mode: 'ascii', appendNewline: 'crlf', color: '#8b5cf6' }
]

let idCounter = 1
function genId(): string {
  return `c${Date.now().toString(36)}${idCounter++}`
}

/** 全局共享 store：快速命令列表跨会话统一（增删改查直接操作，无需经 session）。 */
export const useCommandsStore = defineStore('commands', () => {
  const commands = ref<QuickCommand[]>(storage.get('commands', PRESETS))

  watch(commands, (val) => persistNow('commands', val), { deep: true })

  function add(cmd: Omit<QuickCommand, 'id'>) {
    commands.value.push({ ...cmd, id: genId() })
  }

  function update(id: string, patch: Partial<QuickCommand>) {
    const idx = commands.value.findIndex((c) => c.id === id)
    if (idx >= 0) commands.value[idx] = { ...commands.value[idx], ...patch }
  }

  function remove(id: string) {
    commands.value = commands.value.filter((c) => c.id !== id)
    resetSeq(id)
  }

  function duplicate(id: string) {
    const c = commands.value.find((x) => x.id === id)
    if (c) commands.value.push({ ...c, id: genId(), name: c.name + ' 副本' })
  }

  /** 拖拽排序：把 from 位置元素移动到 to 位置 */
  function move(from: number, to: number) {
    if (from === to) return
    const arr = commands.value.slice()
    const [item] = arr.splice(from, 1)
    arr.splice(to, 0, item)
    commands.value = arr
  }

  // ── 占位符 {seq} 的自增序号 ──
  // 每命令独立计数器（keyed by command id），运行态内存值，不持久化（重启归零）。
  const seqCounters = ref<Record<string, number>>({})

  /** 取下一个序号并递增（每次发送/每次循环迭代调用一次） */
  function nextSeq(id: string): number {
    const n = (seqCounters.value[id] ?? 0) + 1
    seqCounters.value = { ...seqCounters.value, [id]: n }
    return n
  }

  function resetSeq(id: string) {
    const next = { ...seqCounters.value }
    delete next[id]
    seqCounters.value = next
  }

  function exportJson(): string {
    return JSON.stringify(commands.value, null, 2)
  }

  function importJson(json: string): { ok: boolean; error?: string } {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) return { ok: false, error: '根节点必须是数组' }
      // 重新生成 id，避免冲突
      commands.value = parsed.map((c: QuickCommand) => ({ ...c, id: genId() }))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '解析失败' }
    }
  }

  function resetToPresets() {
    commands.value = structuredClone(PRESETS)
  }

  return { commands, add, update, remove, duplicate, move, nextSeq, exportJson, importJson, resetToPresets }
})
