/**
 * 持久化数据体积估算 —— 仅用于容量监控的粗粒度统计。
 * 以 JSON 序列化长度近似 localStorage 占用量（键前缀另计），
 * 精度足够判断是否接近 5MB 配额，无需精确到字节。
 */
export const JSON_BYTES_PER_CHAR = 1

export function estimateJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    // 循环引用等不可序列化数据按 0 计，容量监控不会因坏数据误报
    return 0
  }
}
