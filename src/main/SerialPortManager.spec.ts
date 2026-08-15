import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mock 类与实例数组都在 vi.hoisted 中定义：hoisted 早于 vi.mock 执行，
// 工厂可引用 MockSerialPort，测试拿到强类型实例数组（无需 any）。
const { MockSerialPort, portInstances, openFailPaths, failingConstructPaths } = vi.hoisted(() => {
  const portInstances: MockSerialPort[] = []
  // 需要模拟「打开失败」的端口路径：open 时按此 Error 失败（探测 busy / 连接报错用）。
  // key=路径，value=失败 Error；是否判为「被占用」由错误信息是否命中锁定类决定
  const openFailPaths = new Map<string, Error>()
  // 需要模拟「探测构造失败」的端口路径：new SerialPort 时抛错（验证不阻塞枚举）
  const failingConstructPaths = new Set<string>()
  // 最小可观察的 SerialPort 替身：EventEmitter 语义 + vi.fn 方法便于断言调用
  class MockSerialPort {
    path: string
    _h: Record<string, Array<(...a: unknown[]) => void>> = {}
    on(ev: string, cb: (...a: unknown[]) => void) {
      (this._h[ev] ??= []).push(cb)
      return this
    }
    emit(ev: string, ...args: unknown[]) {
      (this._h[ev] ??= []).forEach((cb) => cb(...args))
    }
    open = vi.fn((cb: (e: Error | null) => void) => {
      const failErr = openFailPaths.get(this.path)
      if (failErr) {
        cb(failErr)
        this.emit('error', failErr)
        return
      }
      this.emit('open')
      cb(null)
    })
    close = vi.fn(() => {
      this.emit('close')
    })
    write = vi.fn((_d: unknown, cb: (e: Error | null) => void) => cb(null))
    drain = vi.fn((cb: (e: Error | null) => void) => cb(null))
    set = vi.fn((_o: Record<string, boolean>, cb: (e: Error | null) => void) => cb(null))
    get = vi.fn((cb: (e: Error | null, s?: { cts: boolean; dsr: boolean; dcd: boolean }) => void) =>
      cb(null, { cts: false, dsr: false, dcd: false })
    )
    static list = vi.fn(async () => [] as unknown[])
    constructor(options?: { path?: string }) {
      this.path = options?.path ?? ''
      if (failingConstructPaths.has(this.path)) throw new Error('construct failed')
      portInstances.push(this)
    }
  }
  return { MockSerialPort, portInstances, openFailPaths, failingConstructPaths }
})

vi.mock('./logger', () => ({
  // 主进程 logger 可能依赖 electron，整块替换避免在 jsdom 下加载
  mainLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

vi.mock('serialport', () => ({ SerialPort: MockSerialPort }))

import { SerialPortManager, toCalloutPath } from './SerialPortManager'

const OPTS = {
  baudRate: 115200,
  dataBits: 8 as const,
  stopBits: 1 as const,
  parity: 'none' as const,
  flowControl: 'none' as const,
}

type WinArg = ConstructorParameters<typeof SerialPortManager>[0]

function makeWin() {
  const send = vi.fn()
  // SerialPortManager 仅用到 isDestroyed / webContents.send，构造一个最小桩
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as WinArg
  return { win, send }
}

describe('toCalloutPath · macOS tty → cu 换算', () => {
  it('darwin 下把 /dev/tty.* 换算成 /dev/cu.*', () => {
    expect(toCalloutPath('/dev/tty.usbserial-2430', 'darwin')).toBe('/dev/cu.usbserial-2430')
  })

  it('非 darwin 平台原样返回', () => {
    expect(toCalloutPath('/dev/ttyUSB0', 'linux')).toBe('/dev/ttyUSB0')
    expect(toCalloutPath('COM5', 'win32')).toBe('COM5')
  })

  it('非 tty 前缀的 darwin 路径原样返回', () => {
    expect(toCalloutPath('/dev/cu.usbserial-2430', 'darwin')).toBe('/dev/cu.usbserial-2430')
  })
})

describe('SerialPortManager · listPortsAsync', () => {
  let mgr: SerialPortManager

  beforeEach(() => {
    portInstances.length = 0
    openFailPaths.clear()
    failingConstructPaths.clear()
    mgr = new SerialPortManager(makeWin().win)
  })

  afterEach(() => {
    mgr.destroy()
    openFailPaths.clear()
    failingConstructPaths.clear()
  })

  it('过滤伪终端并换算成 callout 路径', async () => {
    MockSerialPort.list.mockResolvedValue([
      { path: '/dev/tty.usbserial-2430', vendorId: '1a86', productId: '7523' },
      { path: '/dev/tty.usbmodem2303', manufacturer: 'STMicroelectronics' },
      { path: '/dev/tty.debug-console' },
      { path: '/dev/tty.Bluetooth-Incoming-Port' }
    ])
    const list = await mgr.listPortsAsync()
    expect(list).toHaveLength(2)
    // 本机平台为 darwin 时换算成 cu；其他平台保持 tty —— 两种断言都成立
    expect(list.map((i) => i.path)).toEqual(
      process.platform === 'darwin'
        ? ['/dev/cu.usbserial-2430', '/dev/cu.usbmodem2303']
        : ['/dev/tty.usbserial-2430', '/dev/tty.usbmodem2303']
    )
    expect(list[0].vendorId).toBe('1a86')
    expect(list[0].productId).toBe('7523')
    expect(list[1].manufacturer).toBe('STMicroelectronics')
  })

  it('空闲端口探测为 busy:false 且探测实例立即关闭释放', async () => {
    MockSerialPort.list.mockResolvedValue([{ path: 'COM5' }])
    const list = await mgr.listPortsAsync()
    expect(list[0]).toMatchObject({ path: 'COM5', busy: false })
    // 探测打开成功后立即关闭，不留句柄
    const probe = portInstances.find((p) => p.path === 'COM5')
    expect(probe?.close).toHaveBeenCalled()
  })

  it('被其他程序占用的端口探测为 busy:true，空闲端口为 false', async () => {
    openFailPaths.set('COM9', new Error('Resource busy'))
    MockSerialPort.list.mockResolvedValue([{ path: 'COM9' }, { path: 'COM10' }])
    const list = await mgr.listPortsAsync()
    expect(list.find((i) => i.path === 'COM9')?.busy).toBe(true)
    expect(list.find((i) => i.path === 'COM10')?.busy).toBe(false)
  })

  it('非锁定类打开失败（无权限/设备不存在）不判 busy——端口保持可选', async () => {
    // 回归：EACCES 权限不足不是「被其他程序占用」，判 busy 会把端口禁用，
    // 用户连选中查看真实错误的机会都没有。错误信息含 "cannot open" 也不应触发
    openFailPaths.set('COM5', new Error('Permission denied, cannot open /dev/ttyUSB0'))
    openFailPaths.set('COM6', new Error('Cannot open /dev/ttyUSB0: No such file or directory'))
    MockSerialPort.list.mockResolvedValue([{ path: 'COM5' }, { path: 'COM6' }])
    const list = await mgr.listPortsAsync()
    expect(list[0].busy).toBe(false)
    expect(list[1].busy).toBe(false)
  })

  it('本应用已打开的端口跳过探测（busy:false，不新增探测实例）', async () => {
    await mgr.open('COM5', OPTS)
    const opened = portInstances.length
    MockSerialPort.list.mockResolvedValue([{ path: 'COM5' }])
    const list = await mgr.listPortsAsync()
    expect(list[0].busy).toBe(false)
    // 探测跳过 _ports 中已占用的端口：没有新增 SerialPort 实例
    expect(portInstances.length).toBe(opened)
  })

  it('单端口探测构造失败不阻塞枚举（其余端口仍列出）', async () => {
    // 回归：构造抛异常若向上传播，Promise.all 会 reject → listPortsAsync 返回 []，列表刷不出
    failingConstructPaths.add('COM5')
    MockSerialPort.list.mockResolvedValue([{ path: 'COM5' }, { path: 'COM6' }])
    const list = await mgr.listPortsAsync()
    expect(list.map((i) => i.path)).toEqual(['COM5', 'COM6'])
    // 探测失败的端口不标记占用；正常端口照常探测为空闲
    expect(list[0].busy).toBe(false)
    expect(list[1].busy).toBe(false)
  })

  it('枚举异常返回空数组', async () => {
    MockSerialPort.list.mockRejectedValue(new Error('boom'))
    await expect(mgr.listPortsAsync()).resolves.toEqual([])
  })
})

describe('SerialPortManager · 多端口', () => {
  let mgr: SerialPortManager
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    portInstances.length = 0
    openFailPaths.clear()
    const ctx = makeWin()
    mgr = new SerialPortManager(ctx.win)
    send = ctx.send
  })

  afterEach(() => {
    mgr.destroy()
  })

  it('同端口二次 open 被拒绝（提示占用）', async () => {
    await mgr.open('COM5', OPTS)
    await expect(mgr.open('COM5', OPTS)).rejects.toThrow('串口已被占用')
  })

  it('打开被其他进程锁定的端口报可读占用提示（跨进程占用）', async () => {
    // 另一 KART 实例/程序占用：本进程 _ports 无此端口，serialport 底层 lock 失败
    // 应映射为「已被其他程序占用」，而非原始的技术化错误
    openFailPaths.set('COM5', new Error('Resource busy'))
    await expect(mgr.open('COM5', OPTS)).rejects.toThrow(/已被其他程序占用/)
  })

  it('打开无权限/设备不存在的端口报真实错误而非占用提示', async () => {
    // 回归：错误信息含 "cannot open" 但并非端口被锁（Linux 设备不存在时
    // serialport 报 Cannot open <path>: No such file...），不能误映射为占用
    openFailPaths.set('COM6', new Error('Cannot open /dev/ttyUSB0: No such file or directory'))
    await expect(mgr.open('COM6', OPTS)).rejects.toThrow(/打开串口 COM6 失败: Cannot open/)
  })

  it('不同端口可并发打开', async () => {
    await mgr.open('COM5', OPTS)
    await mgr.open('COM6', OPTS)
    expect(portInstances).toHaveLength(2)
  })

  it('数据事件 payload 携带端口路径', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('data', Buffer.from([1, 2, 3]))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('serial:data', expect.objectContaining({ path: 'COM5' }))
    expect((send.mock.calls[0][1] as { data: unknown }).data).toBeInstanceOf(Uint8Array)
  })

  it('多端口数据按路径分发（互不干扰）', async () => {
    await mgr.open('COM5', OPTS)
    await mgr.open('COM6', OPTS)
    const [p5, p6] = portInstances
    send.mockClear()
    p5.emit('data', Buffer.from([1]))
    p6.emit('data', Buffer.from([2]))
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[0][1] as { path: string }).path).toBe('COM5')
    expect((send.mock.calls[1][1] as { path: string }).path).toBe('COM6')
  })

  it('物理断连（仅 close 事件）推送断连通知 -- 自动重连依赖此信号', async () => {
    // 回归测试：旧实现 close 处理器先删 entry 再 _sendError，而 _sendError 的
    // has(path) 守卫会吞掉通知，渲染端永远收不到断连事件 -> 自动重连失效
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('close') // 模拟物理拔线（无 error 事件）
    expect(send).toHaveBeenCalledWith('serial:error', { path: 'COM5', msg: '串口已断开' })
  })

  it('主动 close(path) 不误报断连', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    mgr.close('COM5') // 先删 entry，port.close() 触发的 close 事件查不到 entry -> 不发
    expect(send).not.toHaveBeenCalled()
    // 端口已释放，可重新打开
    await expect(mgr.open('COM5', OPTS)).resolves.toBeUndefined()
  })

  it('运行时 error 推送错误并关闭端口', async () => {
    await mgr.open('COM5', OPTS)
    send.mockClear()
    portInstances[0].emit('error', new Error('boom'))
    expect(send).toHaveBeenCalledWith('serial:error', { path: 'COM5', msg: '串口错误: boom' })
    // close(path) 已执行，端口释放，可重开
    await expect(mgr.open('COM5', OPTS)).resolves.toBeUndefined()
  })

  it('write 按端口路径写入并返回字节数', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    const n = await mgr.write('COM5', Buffer.from([1, 2, 3]))
    expect(n).toBe(3)
    expect(port.write).toHaveBeenCalled()
  })

  it('write 未打开端口抛错', async () => {
    await expect(mgr.write('COM9', Buffer.from([1]))).rejects.toThrow('串口未打开')
  })

  it('setSignals 调用 port.set 且只传入提供的项', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    await mgr.setSignals('COM5', { dtr: true })
    expect(port.set).toHaveBeenCalledWith({ dtr: true }, expect.any(Function))
    await mgr.setSignals('COM5', { rts: false })
    expect(port.set).toHaveBeenCalledWith({ rts: false }, expect.any(Function))
  })

  it('setSignals 未打开端口抛错', async () => {
    await expect(mgr.setSignals('COM9', { dtr: true })).rejects.toThrow('串口未打开')
  })

  it('setBreak 通过 port.set({ brk }) 置位/清除', async () => {
    await mgr.open('COM5', OPTS)
    const port = portInstances[0]
    await mgr.setBreak('COM5', true)
    expect(port.set).toHaveBeenCalledWith({ brk: true }, expect.any(Function))
    await mgr.setBreak('COM5', false)
    expect(port.set).toHaveBeenCalledWith({ brk: false }, expect.any(Function))
  })

  it('setBreak 未打开端口抛错', async () => {
    await expect(mgr.setBreak('COM9', true)).rejects.toThrow('串口未打开')
  })
})
