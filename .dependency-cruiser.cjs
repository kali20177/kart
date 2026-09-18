/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        '循环依赖：模块互相引用会形成编译期/运行时耦合网，改动一处要全局理解。当前已知两组：stores 四连环（messages⇄pause⇄waveform⇄serial）与 types.ts⇄decoders/types.ts 类型环。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: '本模块无法解析，通常是路径错误或漏装依赖。',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        '孤儿模块：没有任何模块依赖它。例外：electron 多入口（src/main、src/preload、src/renderer.ts）由构建配置物理引入，声明文件（electron-env.d.ts / env.d.ts）不算。',
      from: {
        orphan: true,
        pathNot:
          '^src/(main|preload|test)/|^src/renderer\\.ts$|^src/electron-env\\.d\\.ts$|^src/env\\.d\\.ts$',
      },
      to: {},
    },
    {
      name: 'not-to-composables-from-stores-and-utils',
      severity: 'error',
      comment:
        '层次倒挂：stores/ 与 utils/ 应是叶子（被上层依赖），不应反向依赖 composables/（UI 组合层）。有倒挂说明该逻辑更接近纯工具，应下沉 utils 或独立模块。2026-09-18 已清零（useStorage/useFrameSplitter/useFileWriter/useRecordDirectory 下沉 utils），保持为 error 防回归。',
      from: { path: '^(src/stores/|src/utils/)' },
      to: { path: '^src/composables/' },
    },
    {
      name: 'not-to-session-from-utils',
      severity: 'error',
      comment:
        'utils/ 是最底层叶子，不应依赖会话编排模块 session/index.ts。2026-09-18 已清零（utils/composer.ts 参数收窄为 ComposerSession 最小结构类型），保持为 error 防回归。',
      from: { path: '^src/utils/' },
      to: { path: '^src/session/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm'],
    },
    exclude: {
      path: '(spec|test)\\.ts$',
    },
    includeOnly: '^src',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      archi: {
        collapsePattern: '^(?:node_modules|packages|src|lib|app|bin|test(s)?|spec(s)?)/[^/]+|^src/([^/]+/)',
      },
    },
  },
}