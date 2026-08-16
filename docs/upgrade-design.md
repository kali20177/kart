# 应用自升级（自动更新）设计

> 2026-08-16。基于当前 master（CI/CD 已跑通：`.github/workflows/ci.yml`，tag `v*` 触发构建 + 发布 GitHub Release）。

## 一、背景与目标

串口调试助手已通过 GitHub CI/CD 自动打包（macOS dmg/zip、Windows nsis、Linux AppImage/deb）并发布到 GitHub Releases（`kali20177/kart`，公开仓库）。下一步是**应用内自升级**：用户启动应用后能发现新版本、下载并安装，而不必手动去 Release 页下载安装包。

核心约束（串口工具特有）：
- **绝不自动重启**：用户可能正连着设备、跑着录制/文件下发，安装时机必须由用户决定。
- **不打断当前会话**：下载可在后台进行，仅最终"重启安装"一步需要用户确认。
- **三平台行为差异**：macOS 无签名证书无法自动更新，须优雅降级为手动下载；Linux deb 安装无法自动更新（仅 AppImage）。

## 二、选型

采用 **`electron-updater`**（electron-builder 官方配套库，`electron-builder@24` 自带同版本生态，`electron-updater@^6`）。

不采用 Electron 内置 `autoUpdater`：它只支持 macOS(Squirrel.Mac) / Windows(Squirrel.Windows)，不支持 Linux，且与 GitHub Releases 无原生集成；`electron-updater` 原生支持 GitHub provider、三平台、差分更新（blockmap，当前 CI 已上传 blockmap 文件）、发布说明（releaseNotes）。

**发布源选 GitHub Releases**：与现有 CI 发布链路一致、公开仓库无需 token、provider 原生支持。国内访问 GitHub 慢/不通的问题在"八、网络与镜像"单独处理（v1 用"失败→手动下载兜底"，不做镜像源，避免引入 Gitee 100MB/文件限制、无原生 provider 等新复杂度）。

## 三、现状盘点：缺口分析

| 环节 | 现状 | 缺口 |
| --- | --- | --- |
| 构建产物 | CI 产出 dmg/zip/exe/AppImage/deb + blockmap | 无 `latest*.yml` 元数据文件（**updater 找不到版本，这是最大缺口**） |
| 发布 | tag `v*` → softprops 上传全部 asset 到 GitHub Release | asset 里没有 `latest*.yml`（同上行） |
| 构建配置 | `electron-builder.json` 的 `publish: null` | 需要 github provider（yml 生成 + 运行时 `app-update.yml` 都依赖它） |
| 运行时 | 主进程无任何更新逻辑 | 需新增 Updater 模块 + IPC + preload 桥 |
| UI | MenuBar「帮助」菜单有 快捷键/关于/许可证 等 | 无"检查更新"入口与更新对话框 |
| 依赖 | devDependencies 无 electron-updater | 需加 **dependencies**（随应用打包进 node_modules） |

要点：`latest.yml`（Windows）/ `latest-mac.yml`（macOS）/ `latest-linux.yml`（Linux）是 electron-builder 在**配置了 publish provider 时**才生成，当前 `publish: null` 完全不产出。这是升级功能能否工作的第一前提。

## 四、总体架构

```
┌─ 渲染进程 ─────────────────────────────────────────────┐
│ MenuBar「检查更新」 / 启动自动检查                         │
│   ↓ invoke            ↑ push (updater:event)           │
│ useUpdater (composable, 模块级单例状态)                  │
│ UpdateDialog：checking / available / downloading /      │
│   downloaded(立即重启|稍后) / error(重试|手动下载)         │
└──────────────┬──────────────────────┬───────────────────┘
        preload (updater.* 桥)    contextBridge
┌──────────────┴──────────────────────┴───────────────────┐
│ 主进程 src/main/Updater.ts（单例）                       │
│   electron-updater autoUpdater 封装                      │
│   autoDownload=false  autoInstallOnAppQuit=true         │
│   gate：!app.isPackaged → 不可用；Linux 无 APPIMAGE → 不可用 │
│   事件→`updater:event` 推送；日志走 mainLogger            │
└──────────────────────────┬──────────────────────────────┘
                    GitHub Releases (public, 免 token)
```

## 五、发布链路改动（先落地，否则后面都是空中楼阁）

### 5.1 `electron-builder.json`：加 github provider

```jsonc
"publish": {
  "provider": "github",
  "owner": "kali20177",
  "repo": "kart",
  "releaseType": "release"
}
```

作用：
1. 构建时生成 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`（NSIS/AppImage/mac zip 各自的目标块生成对应 yml，dmg/deb 不生成——debian 无自动更新能力，属预期）。
2. 打包时把该配置烘焙进应用资源 `app-update.yml`，运行时 `electron-updater` 据此知道 feed URL，无需代码里硬编码。

⚠️ 注意（复用 66e733d 的教训）：**不要在 config 里写 `"publish": "never"`**（字符串会被当作 provider 名去加载 `electron-publisher-never`）。禁用自动上传要用 **CLI 标志**。

### 5.2 `package.json`：构建脚本加 `--publish never`

```jsonc
"electron:build": "... && electron-builder --publish never"
```

原因：设置 publish provider 后，electron-builder 默认发布策略 `onTagOrDraft` 会在 tag 构建时尝试创建/发布 Release——CI build job 的 `GITHUB_TOKEN` 是 `contents: read` 只读的，会 403 失败，把 tag 构建弄红。`--publish never` 保证 builder 只生成 yml、绝不主动上传；发布统一走现有 release job（softprops）。本地构建同理受益（不会误发布）。

### 5.3 CI：build job 上传产物补 `latest*.yml`

`ci.yml` build job 的 upload-artifact `path` 追加：

```yaml
release/latest.yml
release/latest-mac.yml
release/latest-linux.yml
```

release job 已 `files: release-assets/**`，yml 会随 artifact 合并进 GitHub Release。至此"发 tag → 三平台安装包 + 元数据齐全的 Release"闭环。

### 5.4 依赖

- `npm i electron-updater` 进 **dependencies**（不是 devDependencies）——electron-builder 打包生产依赖进应用 node_modules，electron-updater 含平台相关动态 require，不进 bundle 更稳。
- `vite.config.ts` 主进程 `external` 列表追加 `'electron-updater'`（与 `serialport` 同列；bundle 外置、运行时从应用 node_modules 解析）。
- 版本：`electron-updater@^6`（与 electron-builder 24 配套）。

## 六、主进程 Updater 模块 + IPC + preload

### 6.1 `src/main/Updater.ts`（单例，惰性初始化）

```
状态机：unavailable | idle → checking → available → downloading → downloaded → (quitAndInstall)
                              └──────────→ not-available / error
```

- 构造 gate：`!app.isPackaged`（dev/preview 不可用，避免 yml 缺失与无谓网络请求）；`process.platform === 'linux' && !process.env.APPIMAGE`（deb 安装不可自动更新）；其余平台可用。
- 配置：`autoUpdater.autoDownload = false`（下载需用户显式确认——安装包可达百 MB 级，且国内网络环境下自动下载体验差）；`autoUpdater.autoInstallOnAppQuit = true`（"稍后"的语义：不重启，自然退出时静默安装）。
- API（供 IPC 调用）：`check()`（`autoUpdater.checkForUpdates()`）、`download()`、`quitAndInstall()`（`autoUpdater.quitAndInstall(false, true)`）、`openReleases()`（`shell.openExternal('https://github.com/kali20177/kart/releases/latest')`，手动下载兜底）。
- 事件→推送：`checking-for-update` / `update-available`(info) / `update-not-available` / `download-progress`(percent,bytesPerSecond,transferred,total) / `update-downloaded`(info) / `error`(err) 统一映射为 `{ type, payload }` 经 `webContents.send('updater:event', ...)` 推给渲染端。info 里带 `version/releaseDate/releaseNotes/files[].size`。
- 启动自动检查：`app.whenReady` 后延迟 ~5s 静默 `check()`（不打扰启动；有更新才推事件，渲染端弹窗，无更新不发声）。手动检查与自动检查共用同一通道，避免并发（进行中直接返回当前状态）。
- 日志：全部走 `mainLogger`（检查/下载/错误，含版本信息），与现有 IPC 模块风格一致。

### 6.2 IPC（`src/main/index.ts` 内 `registerUpdaterIpc`）

- `updater:get-state`（invoke）→ 返回当前状态快照（渲染端挂载时同步用，防事件早于订阅）。
- `updater:check`（invoke）、`updater:download`（invoke）、`updater:quit-and-install`（invoke）、`updater:open-releases`（invoke）。
- 推事件：`updater:event`。

### 6.3 preload（`src/preload/index.ts` + `electron-env.d.ts`）

```ts
updater: {
  getState(): Promise<UpdaterState>
  check(): Promise<void>
  download(): Promise<void>
  quitAndInstall(): Promise<void>
  openReleases(): Promise<void>
  onEvent(handler: (e: UpdaterEvent) => void): () => void   // Set 转发，返回退订，风格同 serial.onData
}
```

`electron-env.d.ts` 补 `UpdaterState` / `UpdaterEvent` 类型（可在 `src/types.ts` 或 updater 模块内定义，`d.ts` 引用）。

## 七、渲染端 UI

### 7.1 入口

- MenuBar「帮助」菜单在「快捷键」与「关于」之间插入 `menu.checkUpdate`（「检查更新…」）。
- 浏览器环境（`window.electron` 缺失）不显示该项；Electron dev 模式（updater 状态 `unavailable`）点击 toast「桌面版可用」提示（`update.unavailable`）。

### 7.2 `src/composables/useUpdater.ts`

模块级单例 reactive 状态 + `check/download/quitAndInstall/openReleases` 动作 + `onEvent` 订阅装配（`window.electron?.updater` 不存在时状态恒为 `unavailable`）。风格对齐 `useMessageSearch` / 现有 persist 事件消费。

### 7.3 `src/components/UpdateDialog.vue`（NModal preset card，风格对齐 About 弹窗）

| 状态 | 内容 | 操作 |
| --- | --- | --- |
| checking | 转圈 + 「正在检查更新…」 | — |
| available | 当前 vX → 新版本 vY、发布日期、包大小、releaseNotes（纯文本展示，不做富渲染，规避 CSP/注入） | 「下载并安装」 |
| downloading | NProgress 进度条 + 百分比 + 速度 + 已下/总量 | 「后台下载中…」（可关弹窗，下载继续） |
| downloaded | 已下载完成 | 「立即重启」「稍后」（稍后=关弹窗，自然退出时自动安装） |
| error | 错误原因 + 断网提示 | 「重试」「手动下载」（openReleases） |
| not-available | 不弹窗，toast「已是最新版本」 | — |

- **重启保护**：点「立即重启」前检查当前活动会话——录制中（`recorder.state.status !== 'idle'`）或有活跃文件下发（transfer）时弹确认框提示「正在录制/下发，重启会中断」，用户确认才 `quitAndInstall`。
- 「稍后」文案明确「更新将在下次退出应用时自动安装」，与 `autoInstallOnAppQuit=true` 语义对齐。

### 7.4 i18n

`src/locales/zh-CN.ts` / `en-US.ts` 新增 `update:` 命名空间（zh/en 结构编译期互检，跟随现有惯例）。

## 八、平台差异与降级

| 平台 | 自动更新 | 说明 |
| --- | --- | --- |
| Windows (nsis) | ✅ | 未签名可更新（首次安装有 SmartScreen 警告，属证书问题非 updater 问题）；oneClick 静默安装 |
| Linux (AppImage) | ✅ | 需 `APPIMAGE` 环境变量（AppImage 启动方式），否则判定 unavailable |
| Linux (deb) | ❌ | electron-updater 不支持 deb；该渠道用户手动下载。gate 已覆盖 |
| macOS (zip) | ⚠️ | **electron-updater 在 macOS 要求应用已用 Developer ID 签名**（Gatekeeper）；当前构建无签名 → 更新大概率在下载/安装阶段失败 |

> **实测印证（2026-08-16 本地打包冒烟）**：本地构建的未签名 `KART.app` 直接启动即被 Gatekeeper 拦截并弹窗「未打开 KART.app，因其包含恶意软件」——连本地打包产物都如此，macOS 无签名路径的"手动下载兜底"是必须的。本地验证打包产物时需右键→打开（或 `xattr -dr com.apple.quarantine`）；日常迭代验证走 `KART_UPDATE_DEV=1` dev 流程（不经 Gatekeeper）。

macOS 处理（v1 简洁方案）：正常走 `check()`，若下载/安装阶段抛错，错误状态里展示「macOS 自动更新不可用」+「手动下载」按钮（openReleases）。后续若购买 Apple Developer 证书（$99/年），在 electron-builder mac 块补 `identity`/`hardenedRuntime` + 公证，升级功能即全自动生效，渲染端无需改动（升级能力位由构建产物决定）。是否买证书属产品决策，见「十一、待确认」。

## 九、网络与镜像

- 检查走 `api.github.com/repos/kali20177/kart/releases/latest`，下载走 `github.com/.../releases/download/...`（公开仓库免 token）。
- 国内网络不通时：updater 报错 → error 状态 + 「手动下载」。不再做更多（v1 范围）。
- 未来增强（P2，非本期）：`generic` provider 指到 CDN 镜像（如 gh-proxy 类、或自建服务器），不依赖 Gitee（Release 单文件 100MB 上限，AppImage/dmg 可能超）。切换 provider 对渲染端透明（feed 来自构建期烘焙的 app-update.yml）。

## 十、与现有机制的交互点（实现时重点验证）

1. **`will-quit` 刷盘**（`index.ts:493`）：现逻辑 `preventDefault` + 异步刷日志 + `app.exit(0)`。`quitAndInstall` 的安装器在 `before-quit` 已 spawn，理论上不受影响，但**必须真机验证**：Windows NSIS 升级安装不丢失、macOS zip 替换成功、退出流程不被 `app.exit(0)` 打断。若有冲突，在 Updater 内记录"待安装"标志，will-quit 分支特判。
2. **多会话/录制流清理**（`index.ts:425` closed 时 end 录制流）：重启安装前若录制流未 close，数据可能截断。重启保护（7.3）已挡一层；「稍后」路径下用户自然退出走正常清理，无此问题。
3. **`app.getVersion()`**：来自打包内 package.json（electron-builder 烘焙构建期 version），与 `__APP_VERSION__`（About 对话框）同源，比较语义一致。
4. **preload 订阅时机**：渲染端 `useUpdater` 挂载时先 `getState()` 同步快照，再订阅 `updater:event`，避免启动自动检查的事件在订阅前到达丢失。

## 十一、测试计划

### 本地验证钩子（已落地，P0 实现的一部分）

不打包即可验证「检查→下载→下载完成」全链路（安装替换需真实平台，见下）：

- **`dev-app-update.yml`（仓库根）+ `KART_UPDATE_DEV=1`**：dev 模式下置
  `autoUpdater.forceDevUpdateConfig = true`，electron-updater 读取项目根的
  `dev-app-update.yml`（generic provider → `http://127.0.0.1:8765`）。用法
  （详见文件头注释）：先 `npm run electron:build` 产出 `release/`（含
  `latest-mac.yml`），`cd release && python3 -m http.server 8765`，再
  `KART_UPDATE_DEV=1 npm run electron:dev`。注意 electron-updater 有检查缓存
  （`~/Library/Caches/kart-updater`），反复验证时先删避免误判「已是最新」。
- **`KART_UPDATE_FEED` 环境变量**：任何模式（含打包产物）注入时
  `autoUpdater.setFeedURL({ provider: 'generic', url })` 覆盖烘焙地址——打包产物
  也可指向 localhost 做 e2e，无需为测试专门打一份假地址构建。

- **`src/utils/updater.ts`** 纯函数（有单测）：`isUpdaterActive` gate 矩阵（打包/平台/AppImage/dev 放行）、`updaterReducer` 状态机单步迁移、`toVersionInfo` 契约映射（不泄漏 files/sha512）、`formatBytes/formatSpeed/formatEta`。
- **`src/main/Updater.spec.ts`**（co-located，已实现）：`vi.mock('electron-updater')` 驱动 mock 事件 → 断言完整更新流状态推进 + `updater:event` 广播 payload；gate 分支（isPackaged/APPIMAGE/platform 注入）；构造 env（KART_UPDATE_FEED/DEV）；检查中守卫；scheduleStartupCheck 假定时器。
- **e2e（可选，轻量）**：`verify:updater` 脚本（Playwright CDP）断言 Help 菜单含「检查更新」、dev 模式点击出现「桌面版不可用」toast——真实验证发布链路只能靠发 tag 后人工/脚本实测。
- **端到端发布验证（手动一次，流程文档化）**：`npm version patch` → tag `v0.1.1` → push → CI 全绿 → 检查 Release asset 含三平台安装包 + 三个 yml → 旧版应用内触发更新 → 下载→重启安装完成。

## 十二、发布纪律与版本管理

- 每次发版必须：① `package.json` 升版本；② tag 名 `v*` 与版本一致（如 `v0.1.1`）；③ push 到 GitHub（触发 CI）。
- 版本只升不降；`latest.yml` 中版本与当前应用版本比较决定是否提示。
- **预发布（beta/alpha）纪律**：若发预发布版，GitHub Release 须标 prerelease（softprops `prerelease: true`）——`electron-updater` 默认跳过 prerelease Release，稳定用户不会收到预发布更新；否则版本号策略需谨慎（预发布版本号高于稳定版会误推）。
- **历史 Release 卫生**：旧的 `v0.1.0-alpha` Release 被 unpacked 垃圾资产污染，不影响 updater（updater 读最新 Release 的 yml；且版本低于后续版），但建议在首个干净 Release 后删除清理（待用户确认）。

## 十三、里程碑拆分

- **P0（链路打通）**：electron-updater 依赖 + external；electron-builder publish provider + `--publish never`；CI 补 `latest*.yml` 上传；`Updater.ts` + IPC + preload + `electron-env.d.ts` 类型；`useUpdater` + UpdateDialog + 帮助菜单入口 + 启动自动检查；zh/en i18n；Updater.spec 状态机单测。收口标志：发 `v0.1.1` 后旧版应用端到端更新成功。
- **P1（健壮性）✅ 已完成（2026-08-16）**：错误降级（手动下载兜底全平台）、下载进度/速度/ETA、**取消下载**（CancellationToken + CancelError → 回 available 可重下）、**重启保护（录制/下发活跃时二次确认）**、releaseNotes 展示、macOS 无签名降级提示文案（含 downloaded 态"稍后"不承诺自动安装、主操作改手动下载）。
- **P2（增强，非本期）**：设置项「自动检查更新」开关（settings 迁移）、channel/预发布通道、Gitee/CDN 镜像 generic provider、真机三平台回归。

## 十四、待确认（产品决策）

1. **macOS 签名**：是否购买 Apple Developer 证书（$99/年）开启 mac 全自动更新？不买则 mac 走"手动下载"兜底（本期 P0 即可上线，功能不被阻塞）。
2. **旧 `v0.1.0-alpha` Release**：是否删除清理（现不影响 updater）。
3. **下载策略**：本期 `autoDownload=false`（用户点「下载并安装」才开始下载）。若希望更顺滑可改 `true`（后台自动下载，仅安装需确认）——考虑安装包体积与国内网络，倾向保持 false。

## 十五、与 saucer 迁移的兼容性（2026-08-16 调研结论）

**问题**：项目存在 saucer 迁移实验（worktree `kart-saucer/feat/saucer-migration`，C++ webview 后端，08-09 停滞、master 已反超）。若未来迁移成功，本设计的 electron-updater 还能用吗？

**结论：electron-updater 在 saucer 架构下不可用，但本期设计的"渲染端契约"可无损迁移。**

### 15.1 为什么 electron-updater 用不了（已核实源码，electron-updater@6.8.9）

electron-updater 是跑在 **Node.js（Electron 主进程）** 环境里的库，对 Electron 运行时是硬依赖，抽不掉：

| 依赖点 | 出处 | 说明 |
| --- | --- | --- |
| `require("electron").app` | `ElectronAppAdapter.js` | 构造器默认参数直接注入 Electron 的 `app` |
| `app.whenReady / getVersion / getName / isPackaged / getAppPath / getPath("userData") / quit / relaunch / once("quit")` | `ElectronAppAdapter.js` | 版本比较、安装路径、退出重启全挂在 `app` 上 |
| `process.resourcesPath` | `ElectronAppAdapter.js` | Electron 专属资源路径（定位 `app-update.yml`） |
| `require("electron").Notification` | `AppUpdater.js` | 更新通知 |
| `require("electron").autoUpdater`（Squirrel.Mac） | `MacUpdater.js` | macOS 分支整体委托给 Squirrel.Mac 原生更新器 + 本地代理服务器 |
| `app.appUpdateConfigPath` / `userDataPath` | `ElectronAppAdapter.js` | 读取构建期烘焙的 `app-update.yml` |

saucer 应用是**纯 C++ 原生宿主 + webview**（`saucer::smartview`），无 Node 主进程、无 `require`、无 `app` 对象、无 Squirrel；前端 JS 跑在沙箱 webview（WKWebView/WebView2/WebKitGTK）里，也不能 require 模块。唯一"能让它跑起来"的办法是往 saucer 应用里嵌一个 Node.js sidecar 仅供 updater 使用——与迁移 saucer 甩掉 Electron 足迹的目标直接冲突，不理性。

### 15.2 可迁移的部分：分发通道与渲染端契约

- **GitHub Releases 分发通道可复用**（公开仓库、免 token 的抽象保持不变），但**安装包本身是后端专属的**：electron-builder 的 nsis/dmg/AppImage 安装的是 Electron 应用目录结构；saucer 版是原生二进制 + web 资源，打包路径完全不同（CMake/CPack/NSIS/pkg/AppImage，不经过 electron-builder）。故 saucer 迁移时打包链路需独立重做，与本期 CI 的 electron-builder 产物互不相通。
- **元数据格式**：electron-builder 的 `latest.yml` 格式简单公开（`version` + `files[{url,sha512,size}]` + `sha512` + `releaseDate`），C++ 端读取毫无障碍；若走原生生态标准可切换 Sparkle appcast XML（mac/Windows 原生更新器通用）。届时 saucer 侧 C++ updater（检查→下载→SHA512 校验→执行安装器）为独立小工具，工作量主要在各平台安装器与签名，不在协议。
- **渲染端契约是本设计最有迁移价值的部分**（与 saucer worktree 既定策略一致——`main.cpp` 注释明示"渲染层保持 Electron 时代契约 `window.electron.*`，此处按同一契约实现能力"）：`window.electron.updater.*`（getState/check/download/quitAndInstall/openReleases + `updater:event` 事件流）是后端无关的稳定接口。未来迁移时用 C++ `updater_bridge.cpp` 按同一契约 `expose`（shim 已重建 window.electron），**前端 useUpdater + UpdateDialog + 菜单 + i18n 零改动**。

### 15.3 对本期实现的约束

1. updater 的 IPC 契约与状态机/事件 payload 定义为**稳定公共接口**（类型集中在 `types.ts` 或 updater 模块导出，`electron-env.d.ts` 引用），不泄漏 Electron 细节（app-update.yml / blockmap / Squirrel 语义）到渲染端。
2. 渲染端**永远不直接消费 electron-builder 特有字段**：`UpdateInfo` 只映射为渲染端自有的 `{ version, releaseDate, releaseNotes, totalSize }` 形态。
3. 不因 saucer 迁移设想阻塞本期（saucer worktree 停滞、主线明确是 Electron）；「saucer 侧重写 updater」列为未来迁移时的独立工作项，届时再评估打包/签名/元数据格式。
