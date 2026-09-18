// 下发数据源抽象：pump 只按 [start,end) 随机切片读取，不持有整文件字节。
// 内存源（单测/双路径对照）与文件源（真实下发）字节语义一致。
// File 支持多次随机切片读（file.slice(start,end)），retry/repeat/startOffset
// 的随机重读语义因此无需改动，内存占用从 O(整文件) 降到 O(chunkSize)。

export interface ChunkSource {
  readonly size: number
  slice(start: number, end: number): Promise<Uint8Array>
}

/** 内存字节源（对照基准 / 单测用） */
export const memorySource = (bytes: Uint8Array): ChunkSource => ({
  size: bytes.length,
  slice: async (start, end) => bytes.slice(start, end)
})

/** Blob 读为 ArrayBuffer：优先原生 arrayBuffer()（浏览器/Electron），
 *  jsdom 等环境未实现时回退 FileReader（语义等价）。 */
function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('读取文件切片失败'))
    reader.readAsArrayBuffer(blob)
  })
}

/** 文件源：逐块随机切片读，单次读取上界即切片跨度 */
export const fileSource = (file: File): ChunkSource => ({
  size: file.size,
  slice: async (start, end) => new Uint8Array(await readAsArrayBuffer(file.slice(start, end)))
})