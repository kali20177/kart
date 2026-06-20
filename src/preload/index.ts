import { contextBridge } from 'electron'

// 阶段 1 占位桥：仅暴露运行平台。串口、存储等能力在阶段 2 接入。
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform
})
