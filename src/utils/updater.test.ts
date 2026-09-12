import { describe, it, expect } from 'vitest'
import {
  createUpdaterState,
  isUpdaterActive,
  totalUpdateSize,
  toVersionInfo,
  sanitizeReleaseNotes,
  updaterReducer,
  formatBytes,
  formatSpeed,
  formatEta
} from './updater'

describe('isUpdaterActive（gate 能力位）', () => {
  const base = { isPackaged: true, devEnabled: false, platform: 'darwin' as const, appImage: false }

  it('打包 + 任意非 Linux 平台 → 可用', () => {
    expect(isUpdaterActive(base)).toBe(true)
    expect(isUpdaterActive({ ...base, platform: 'win32' })).toBe(true)
  })

  it('Linux 需要 AppImage 环境（deb 渠道不可自动更新）', () => {
    expect(isUpdaterActive({ ...base, platform: 'linux', appImage: false })).toBe(false)
    expect(isUpdaterActive({ ...base, platform: 'linux', appImage: true })).toBe(true)
  })

  it('非打包（dev/浏览器）默认不可用，devEnabled 显式放行', () => {
    expect(isUpdaterActive({ ...base, isPackaged: false })).toBe(false)
    expect(isUpdaterActive({ ...base, isPackaged: false, devEnabled: true })).toBe(true)
  })

  it('dev 模式下 Linux 无 APPIMAGE 也放行（本地调试）', () => {
    expect(isUpdaterActive({ ...base, isPackaged: false, devEnabled: true, platform: 'linux', appImage: false })).toBe(true)
  })
})

describe('totalUpdateSize / toVersionInfo（原始 UpdateInfo → 契约映射）', () => {
  it('对 files 各 payload 大小求和', () => {
    expect(totalUpdateSize({ version: '1.0.0', files: [{ size: 100 }, { size: 50 }] })).toBe(150)
    expect(totalUpdateSize({ version: '1.0.0', files: [{ size: 0 }] })).toBeUndefined()
    expect(totalUpdateSize({ version: '1.0.0', files: [] })).toBeUndefined()
    expect(totalUpdateSize(null)).toBeUndefined()
  })

  it('只保留公开字段，不泄漏 electron-builder 特有字段', () => {
    // 富信息：模拟 electron-builder 完整 UpdateInfo（含应被剥离的 path/sha512/url 等）
    const rich = {
      version: '1.1.0',
      releaseDate: '2026-08-16T00:00:00.000Z',
      releaseNotes: '修复若干问题',
      files: [
        { size: 42, sha512: 'abc', url: 'https://x' },
        { size: 8, sha512: 'def', url: 'https://y' }
      ],
      path: 'KART-1.1.0.dmg',
      sha512: 'full-sha512',
      stagingPercentage: 10
    }
    const info = toVersionInfo(rich)
    expect(info).toEqual({
      version: '1.1.0',
      releaseDate: '2026-08-16T00:00:00.000Z',
      releaseNotes: '修复若干问题',
      totalSize: 50
    })
    expect(info).not.toHaveProperty('path')
    expect(info).not.toHaveProperty('sha512')
    expect(info).not.toHaveProperty('stagingPercentage')
  })

  it('null/undefined → null', () => {
    expect(toVersionInfo(null)).toBeNull()
    expect(toVersionInfo(undefined)).toBeNull()
  })

  it('HTML releaseNotes（GitHub Atom feed 形态）→ 清洗为纯文本', () => {
    const html =
      '<div class="markdown-body"><p>新增 <strong>RTT</strong> 传输</p><ul><li>修复 A&amp;B</li><li>优化 C &lt; 2</li></ul>' +
      '<p>详见 <a href="https://github.com/kali20177/kart/issues/1">#1</a></p></div>'
    const info = toVersionInfo({ version: '1.1.0', releaseNotes: html, files: [{ size: 10 }] })
    expect(info?.releaseNotes).toBe('新增 RTT 传输\n- 修复 A&B\n- 优化 C < 2\n详见 #1 (https://github.com/kali20177/kart/issues/1)')
  })

  it('ReleaseNoteInfo[] 拼接的 markdown（### vX 头）无标签时透传，连续空行收敛为单个', () => {
    const notes = '### v1.1.0\n- 新增 RTT 传输\n### v1.0.1\n修复若干问题'
    expect(toVersionInfo({ version: '1.1.0', releaseNotes: notes })?.releaseNotes).toBe(notes)
    expect(sanitizeReleaseNotes('### v1.1.0\n- 新增 RTT\n\n### v1.0.1\n修复')).toBe('### v1.1.0\n- 新增 RTT\n### v1.0.1\n修复')
  })
})

describe('sanitizeReleaseNotes（HTML → 可读纯文本）', () => {
  it('空/null/纯空白 → undefined', () => {
    expect(sanitizeReleaseNotes(undefined)).toBeUndefined()
    expect(sanitizeReleaseNotes(null)).toBeUndefined()
    expect(sanitizeReleaseNotes('')).toBeUndefined()
    expect(sanitizeReleaseNotes('   ')).toBeUndefined()
  })

  it('剥掉块级/内联标签并保留文本', () => {
    expect(sanitizeReleaseNotes('<p>hello</p><p>world</p>')).toBe('hello\nworld')
    expect(sanitizeReleaseNotes('<h2>标题</h2><p>正文 <code>x &lt; 3</code></p>')).toBe('标题\n正文 x < 3')
  })

  it('<li> 转列表符号，<br> 转换行', () => {
    expect(sanitizeReleaseNotes('<ul><li>甲</li><li>乙</li></ul>')).toBe('- 甲\n- 乙')
    expect(sanitizeReleaseNotes('第一行<br>第二行')).toBe('第一行\n第二行')
  })

  it('链接保留可见文本并附 http(s) URL，装饰图转 alt', () => {
    expect(sanitizeReleaseNotes('<a href="https://a.b/c">文档</a>')).toBe('文档 (https://a.b/c)')
    expect(sanitizeReleaseNotes('<a href="https://a.b/c">https://a.b/c</a>')).toBe('https://a.b/c')
    expect(sanitizeReleaseNotes('<img alt="截图" src="x.png"> 见上')).toBe('[截图] 见上')
  })

  it('实体解码：命名 + 十进制 + 十六进制', () => {
    expect(sanitizeReleaseNotes('A&amp;B &lt;C&gt; &quot;引号&quot;&nbsp;x')).toBe('A&B <C> "引号" x')
    expect(sanitizeReleaseNotes('&#39;单引&#x27;')).toBe("'单引'")
  })

  it('纯文本透传（含 markdown 符号）', () => {
    expect(sanitizeReleaseNotes('修复若干问题')).toBe('修复若干问题')
    expect(sanitizeReleaseNotes('### v1.1.0\n- 新增 RTT')).toBe('### v1.1.0\n- 新增 RTT')
  })
})

describe('updaterReducer（状态机单步迁移）', () => {
  const idle = createUpdaterState()

  it('check-start/checking → checking 并清空 error', () => {
    const s = updaterReducer({ ...idle, status: 'error', error: 'boom' }, { type: 'check-start' })
    expect(s.status).toBe('checking')
    expect(s.error).toBeNull()
  })

  it('available → 携带版本信息且不泄漏原始结构', () => {
    const s = updaterReducer(idle, { type: 'available', info: { version: '1.1.0', files: [{ size: 10 }] } })
    expect(s.status).toBe('available')
    expect(s.info?.version).toBe('1.1.0')
    expect(s.info?.totalSize).toBe(10)
    expect(s.progress).toBeNull()
  })

  it('not-available → 清空 info/progress/error', () => {
    const s = updaterReducer(
      { status: 'available', info: { version: '1.1.0' }, progress: null, error: null },
      { type: 'not-available' }
    )
    expect(s.status).toBe('not-available')
    expect(s.info).toBeNull()
  })

  it('download-start → downloading，初始进度用 totalSize 兜底', () => {
    const available = updaterReducer(idle, { type: 'available', info: { version: '1.1.0', files: [{ size: 1024 }] } })
    const s = updaterReducer(available, { type: 'download-start' })
    expect(s.status).toBe('downloading')
    expect(s.progress?.total).toBe(1024)
  })

  it('progress 推进且停留在 downloading', () => {
    const downloading = updaterReducer(idle, { type: 'download-start' })
    const s = updaterReducer(downloading, {
      type: 'progress',
      progress: { percent: 42, bytesPerSecond: 1024, transferred: 430, total: 1024 }
    })
    expect(s.status).toBe('downloading')
    expect(s.progress?.percent).toBe(42)
  })

  it('downloaded → 跳终态并清空 progress', () => {
    const downloading = updaterReducer(idle, { type: 'download-start' })
    const s = updaterReducer(downloading, { type: 'downloaded', info: { version: '1.1.0' } })
    expect(s.status).toBe('downloaded')
    expect(s.progress).toBeNull()
    expect(s.info?.version).toBe('1.1.0')
  })

  it('error 记录消息并清空 progress', () => {
    const downloading = updaterReducer(idle, { type: 'download-start' })
    const s = updaterReducer(downloading, { type: 'error', message: '网络不可达' })
    expect(s.status).toBe('error')
    expect(s.error).toBe('网络不可达')
    expect(s.progress).toBeNull()
  })

  it('cancel 回到 available（info 保留，可重新下载）', () => {
    const available = updaterReducer(idle, { type: 'available', info: { version: '1.1.0', files: [{ size: 100 }] } })
    const downloading = updaterReducer(available, { type: 'download-start' })
    const s = updaterReducer(downloading, { type: 'cancel' })
    expect(s.status).toBe('available')
    expect(s.info?.version).toBe('1.1.0')
    expect(s.progress).toBeNull()
    expect(s.error).toBeNull()
  })

  it('downloaded 后再次 available（复查路径需防回归，见 Updater.check 守卫）', () => {
    const downloading = updaterReducer(idle, { type: 'download-start' })
    const downloaded = updaterReducer(downloading, { type: 'downloaded', info: { version: '1.1.0' } })
    expect(updaterReducer(downloaded, { type: 'not-available' }).status).toBe('not-available')
  })

  it('unavailable → 终态', () => {
    const s = updaterReducer(idle, { type: 'unavailable' })
    expect(s.status).toBe('unavailable')
  })
})

describe('格式化', () => {
  it('formatBytes 1024 进制/取整规则', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 * 12)).toBe('12.0 MB')
    expect(formatBytes(1024 * 1024 * 100)).toBe('100 MB')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
  })

  it('formatSpeed 追加 /s', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s')
  })

  it('formatEta 分级与缺数据兜底', () => {
    expect(formatEta(0, 0, 0)).toBe('--')
    expect(formatEta(500, 1024, 1024)).toBe('1s')
    expect(formatEta(64, 1024, 16)).toBe('1m0s')
    expect(formatEta(0, 3600 * 1024, 1024)).toBe('1h0m')
  })
})