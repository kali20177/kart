# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作提供指引。

## 常用命令

```sh
npm run dev        # 启动 Vite 开发服务器（localhost:5273）
npm run build      # 类型检查 + 生产构建（vue-tsc --noEmit && vite build）
npm run preview    # 本地预览生产构建
npm run typecheck  # 仅执行 vue-tsc 类型检查（不输出文件）
npm test           # 运行所有 Vitest 测试（单次）
npm run test:watch # 以 watch 模式运行测试
```

## 项目概览

**阶段 1** 串口调试助手 — 纯浏览器 SPA，使用模拟串口数据。**阶段 2** 将添加 Electron + Web Serial API。

- **框架**：Vue 3（`<script setup>` Composition API）
- **构建**：Vite 5、TypeScript strict、`@/` 路径别名 → `src/`
- **状态管理**：Pinia
- **UI 组件库**：Naive UI（zhCN 中文语言包）
- **测试**：Vitest + jsdom + `@vue/test-utils`
- **注册源**：国内 npm 镜像（`registry.npmmirror.com`），配置在 `.npmrc`
- **无 linter/formatter** —— `vue-tsc` 类型检查是唯一的代码质量门禁

## 架构

### 数据流
所有串口字节数据以 `Uint8Array` 格式存储一次。ASCII/HEX 视图按需计算（切换视图无需重建数据）。高频数据通过 `requestAnimationFrame` 批处理摄入到 messages store，避免压垮 Vue 响应式系统。

### 关键抽象 — SerialDriver 接口
`src/mock/MockSerialSource.ts` 定义了 `SerialDriver` 接口，模拟源和未来的 `WebSerialDriver` 都将实现该接口。Pinia stores 依赖此接口而非具体实现——阶段 2 替换模拟源为真实串口时，store 无需任何改动。

### 层次结构
```
src/types.ts              — 共享类型（Message、PortOptions、QuickCommand、AppSettings）
src/utils/                — 纯工具函数（hex、encoding、ascii-table）—— 无框架依赖
src/mock/                 — MockSerialSource + 场景生成器（阶段 2 被替换）
src/composables/          — Vue composables（useFrameSplitter、useSendHistory、useStorage）
src/stores/               — Pinia stores（serial、messages、commands、settings）
src/components/           — 8 个 Vue 组件（ConnectionBar、MessageList、MessageBubble、
                            InputComposer、QuickCommandsPanel、AsciiTable、SettingsDrawer、StatusBar）
src/App.vue               — 根布局 + 主题切换
src/main.ts               — createApp + Pinia + 挂载
src/styles/tokens.css     — CSS 自定义属性（亮/暗主题、字体、间距）
```

### 组件 ↔ Store 依赖关系
```
App.vue → 所有 stores
ConnectionBar   → serial store
MessageList     → messages store, settings store
  └─ MessageBubble → hex/utils, encoding/utils
InputComposer   → serial store, settings store, useSendHistory
QuickCommandsPanel → commands store, serial store
AsciiTable      → ascii-table/utils
SettingsDrawer  → settings store, serial store
StatusBar       → serial store
```

### 帧分割
`useFrameSplitter.ts` 是一个纯逻辑类（无定时器，可独立测试），通过三种策略将原始字节流拆分为离散帧：间隔超时、分隔符、固定长度。

### 存储抽象
`useStorage.ts` 封装 localStorage，暴露 `{ get, set, remove }` 接口。阶段 2 切换到 `electron-store` 时，调用方无需修改。

## 阶段 2 路线图
1. 添加 Electron + electron-vite + electron-builder
2. 添加 `src/main/`（主进程）和 `src/preload/`（contextBridge）
3. 实现 Web Serial API 的 `SerialDriver`
4. 将 serial store 中的 `MockSerialSource` 替换为真实驱动
5. 将 `useStorage` 从 localStorage 迁移到 electron-store
6. 将 Blob 下载替换为 Electron `dialog` + `fs`