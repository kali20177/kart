import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 应用级「暂停采集」状态——消息视图与波形视图共享的单一真相源。
 *
 * 为什么是全局共享而非各视图独立：
 * 两个视图订阅同一份 serial.onData 字节流，若各自独立暂停，会在各自 ingest 入口丢弃
 * 不同批次的字节 → 采样集合不对齐（时间轴虽对齐，但一个视图有的采样另一个没有）→
 * 「暂停后两边数据失去对照」。统一一个 paused 标志，两个 ingest 入口读同一个值，
 * 丢弃的是同一批字节 → 集合天然对齐。
 *
 * 暂停语义为「冻结采集」，被暂停期间到达的字节直接丢弃（不缓存、不延迟显示），
 * 避免「暂停越久 → 恢复瞬间越灾难」的爆发式刷新；messages 与 waveform 各自的
 * 环形缓冲 / 历史缓冲上限仍对恢复后的正常流量兜底。
 *
 * 录制（recorder store）不依赖此状态——录制是始终审计的保底线，不受显示暂停影响。
 */
export const usePauseStore = defineStore('pause', () => {
  const paused = ref(false)
  const pauseStartTime = ref(0)

  function toggle() {
    paused.value = !paused.value
    if (paused.value) pauseStartTime.value = Date.now()
  }

  return { paused, pauseStartTime, toggle }
})