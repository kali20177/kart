# Electron 主进程串口多端口并发设计

> 关联：`docs/production-gaps.md` 第 14 点「单连接，不支持多端口并发」。
> 日期：2026-08-01。状态：待实施。

## 背景

生产环境缺失功能第 14 点：串口调试助手同一时刻只能连接一个串口，无法同时盯多设备。会话重构（`createSession` 每会话独立驱动实例 + `useSession` 注入）已铺好渲染端底子——每个会话自带独立的 serial/messages/waveform/pause/recorder/transfer 六件套与独立 `SerialDriver` 实例，但 **Electron 侧主进程仍硬性单端口**，阻塞多会话同时连接。

本设计完成 Electron 串口链路的多端口化。**渲染端 `SerialDriver` 接口不变**（每会话一个 `SerialPortDriver` 实例对应一个端口），改动收敛在：主进程多端口管理 + IPC 加端口标识 + preload 多实例订阅 + 渲染端驱动按端口过滤分发。

## 现状（单端口约束清单）

| 层 | 文件 | 单端口约束 |
| --- | --- | --- |
| 主进程 | `src/main/SerialPortManager.ts` | `_port` 单字段，`open()` 内 `if (_isOpen) this.close()`——任何时刻至多一个 `SerialPort` 实例 |
| 主进程 IPC | `src/main/index.ts` | `serial:close/write/get-signals/is-open` 全部无参；`serial:data/error` payload 无端口标识（裸 Uint8Array / 裸字符串） |
| 预加载 | `src/preload/index.ts` | `serialDataHandler`/`serialErrorHandler` 模块级单 handler，`onData/onError` 覆盖式赋值，`removeListeners` 全局清空 |
| 渲染端 | `src/serial/SerialPortDriver.ts` | `_startListening` 注册全局 handler，`_stopListening` 调 `api.removeListeners()` 全局清——多实例会互相踩掉对方订阅 |
| 死代码 | — | `serial:is-open` IPC（主进程 handler + preload 方法）无任何消费方（`SerialDriver` 接口无 `isOpen()` 方法）；`removeListeners` 仅驱动内部使用 |

窗口关闭清理已按窗口组织：`_serialManagers = Map<winId, SerialPortManager>`，`win.on('closed')` → `destroy()`。多端口化后 `destroy()` 遍历关闭全部端口即天然兼容，无需改动。

## 设计决策

1. **IPC payload 形状**：`{ path, data }` / `{ path, msg }` 对象。结构化克隆规范保证 Uint8Array 可零拷贝传输；对象比元组可读，比双 channel 少一次订阅/分发。
2. **同端口二次 open**：reject「串口已被占用: path」。物理设备一次只能被一个 `SerialPort` 实例持有，复用会掩盖「两个会话共享同一端口」的矛盾。错误经 serial store `connect()` catch 自然浮到现有 UI 提示，无需改 UI。
3. **竞态兜底**：主进程推送前查 entry 存在性丢弃残留事件；preload 用 `Set` + 取消函数（多实例不互踩）；渲染端 handler 按 path 过滤，安全忽略非本实例事件。
4. **`serial:is-open` 死代码**：删除。全仓库无消费方，不值得为死代码维持带 portName 的签名。
5. **测试策略**：本轮不写主进程单测——`SerialPortManager` 当前 0 测试，依赖 native serialport binding（vitest jsdom 环境加载失败），结构化克隆行为只有真实 Electron IPC 可验证。以 `electron:dev` 手测 + socat 虚拟串口替代。后续引入 `FakeSerialPort` 构造注入后再补单测。

## 实施步骤

### Step 1 — 主进程多端口管理（`src/main/SerialPortManager.ts`）

```ts
interface PortEntry { port: SerialPort; isOpen: boolean }
private _ports = new Map<string, PortEntry>()
```

- `open(path, options)`：头部 `if (this._ports.has(path)) throw new Error('串口已被占用: ' + path)`（移除强制 close）；`'open'` 事件 → `_ports.set(path, { port, isOpen: true })` + `_attachData(port, path)`；`'error'` 打开阶段（`!entry?.isOpen`）reject / 运行阶段 `_sendError(path, msg)` + `close(path)`；`'close'` 事件 → `if (entry?.isOpen) { entry.isOpen = false; _sendError(path, '串口已断开') }`
- `close(path)`：get entry，`try { port.close() } catch {}`，`_ports.delete(path)`（先删 entry 再触发 close 事件，防误报）
- `write(path, data)`：`!entry?.isOpen` → reject '串口未打开'
- `getSignals(path)`：entry 不存在/未打开 → resolve 全 false
- `_attachData(port, path)`：事件内查 `_ports.get(path)?.isOpen`，非打开则丢弃残留；`webContents.send('serial:data', { path, data: Uint8Array.from(buf) })`
- `_sendError(path, msg)`：查 entry 存在性后 `send('serial:error', { path, msg })`
- `destroy()`：`for (const path of [...this._ports.keys()]) this.close(path)`
- 删除 `isOpen` getter 与 `_isOpen` 字段

### Step 2 — IPC handlers（`src/main/index.ts`）

- `serial:close`：`(event, portName)` → `mgr?.close(portName)`
- `serial:write`：`(event, portName, data)` → `mgr.write(portName, Buffer.from(data))`（移除 `mgr?.isOpen` 预查，manager 内查更准）
- `serial:get-signals`：`(event, portName)` → `mgr?.getSignals(portName)`
- 删除 `serial:is-open` handler
- `serial:open` 签名不变（`(portName, options)` 已有 portName）；窗口 closed 清理不变

### Step 3 — preload 多实例订阅（`src/preload/index.ts`）

- 单 handler 改为 `Set` + 取消函数：

```ts
const dataHandlers = new Set<(data: Uint8Array, path: string) => void>()
ipcRenderer.on('serial:data', (_e, payload: { path: string; data: Uint8Array }) => {
  for (const h of dataHandlers) h(payload.data, payload.path)
})
```

- `onData`/`onError`：`handler => { set.add(handler); return () => set.delete(handler) }` — 返回取消函数
- 删除 `removeListeners`
- 方法签名：`close(portName)`、`write(portName, data)`、`getSignals(portName)`；删除 `isOpen`

### Step 4 — 渲染端驱动按端口过滤（`src/serial/SerialPortDriver.ts`）

- 新增 `private _openPath: string | null = null`；`open()` 成功后赋值，`close()` 开头置 null（防在途事件误入）
- `_startListening()`：保留订阅引用并做 path 过滤：

```ts
this._unsubData = api.onData((data, path) => {
  if (path !== this._openPath) return
  for (const cb of this._listeners) { try { cb(data) } catch {} }
})
this._unsubError = api.onError((msg, path) => {
  if (path !== this._openPath) return
  console.warn('[serial] error:', msg)
  this._isOpen = false
  this._stopSignalPolling()
})
```

- `_stopListening()`：调用两个取消函数（不再 `api.removeListeners()`）
- `ElectronSerial` 接口：`close(portName: string)`、`write(portName: string, data: Uint8Array)`、`getSignals(portName: string)`、`onData(handler: (data: Uint8Array, path: string) => void): () => void`、同型 `onError`；删除 `removeListeners`/`isOpen`
- 断连检测链路不变：`api.onError` 置 `_isOpen=false` → serial store 500ms 轮询检测 `driver.isOpen` 触发 disconnect——path 过滤后依然工作

## 验证

1. `npm run typecheck` + `npm run lint` + `npm test`（现有渲染端 spec 应全绿——驱动接口未变）
2. `socat -d -d pty,raw,echo=0 pty,raw,echo=0` 造两对虚拟串口（macOS）
3. `npm run electron:dev` 手测：
   - 会话 A 开串口 1 + 会话 B 开串口 2，两端互发，确认 A 只收 A 的数据
   - 两会话选同一端口 → UI 提示「串口已被占用」
   - 拔掉会话 A 的虚拟口 → 仅 A 收到「串口已断开」并触发重连，B 不受影响
   - 关窗口 → 主进程日志确认两端口均 close
