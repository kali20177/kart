import { contextBridge } from 'electron'

// 阶段 1 占位桥：暴露运行平台与运行时版本（供「关于」展示 Chromium/Node/V8）。
// 串口、存储等能力在阶段 2 接入。
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions
})
