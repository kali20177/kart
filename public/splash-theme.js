/* 启动加载页主题预上色 —— 同步阻塞脚本，在主 bundle 解析前执行
 * （CSP script-src 'self' 允许同源外链、禁内联，故独立成 public/ 下的文件；
 * index.html 以相对路径 ./splash-theme.js 引用，dev 与 base './' 的 prod 均成立）。
 *
 * 调色板复制自 src/themes/builtin/*.ts 的 tokens（bg/--bg、fg/--text、dim/--text-dim、
 * accent/--accent、ok/--ok）。漂移由 src/themes/splash-theme.spec.ts 锁定：
 * 新增/修改主题时两处必须同步，测试会拦截。
 *
 * 未知/缺失主题不写变量，回落 index.html <style> 内的 fallback（= glass-industrial-dark，
 * 与 main.ts 无持久化设置时的默认主题一致）。themeOverrides（用户字体/背景覆盖）不参与
 * 预载——覆盖项不含终端/splash 颜色，且须在 bundle 后才可解析。
 */
(function () {
  var PALETTES = {
    'glass-industrial-dark': { bg: '#0d1117', fg: '#e6edf3', dim: '#8b949e', accent: '#58a6ff', ok: '#50c878' },
    'glass-industrial-light': { bg: '#f4f6fa', fg: '#0f172a', dim: '#64748b', accent: '#2563eb', ok: '#16a34a' },
    'oled-hud': { bg: '#050508', fg: '#E0E0E8', dim: '#7A8A9A', accent: '#00E676', ok: '#00E676' },
    'retro-console': { bg: '#0D1024', fg: '#E8F0FF', dim: '#8899C8', accent: '#00E5FF', ok: '#3DFF8F' },
  }
  try {
    var raw = localStorage.getItem('kart:settings')
    var cfg = raw ? JSON.parse(raw) : {}
    // 镜像 src/themes/migrate.ts 的字段迁移（splash 只读不写；store 挂载后会正式迁移落盘）：
    // 旧 theme（dark|light）/ 废弃 themeMode → themeId。未知 themeId 走下方 fallback，
    // 与迁移第 3 条的回退目标（glass-industrial-dark）一致。
    if (typeof cfg.theme === 'string') {
      cfg.themeId = cfg.theme === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    } else if (typeof cfg.themeMode === 'string' && typeof cfg.themeId !== 'string') {
      cfg.themeId = cfg.themeMode === 'light' ? 'glass-industrial-light' : 'glass-industrial-dark'
    }
    var p = Object.prototype.hasOwnProperty.call(PALETTES, cfg.themeId) ? PALETTES[cfg.themeId] : null
    document.documentElement.setAttribute('data-splash-theme', p ? cfg.themeId : 'fallback')
    if (!p) return
    var s = document.documentElement.style
    for (var k in p) s.setProperty('--splash-' + k, p[k])
  } catch (e) {
    /* localStorage 不可用/损坏：静默回落 fallback */
  }
})()
