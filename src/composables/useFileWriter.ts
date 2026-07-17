/** 平台无关的文件写入句柄 */
export interface IFileWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  getFileName(): string
}
