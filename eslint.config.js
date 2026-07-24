import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'release/**'] },

  // TypeScript 推荐规则
  ...tseslint.configs.recommended,

  // TypeScript 的 strict mode 已通过 noUnusedLocals / noUnusedParameters
  // 在编译时报错，ESLint 无需重复检查
  { rules: { '@typescript-eslint/no-unused-vars': 'off' } },

  // Vue 推荐规则（flat config）
  ...pluginVue.configs['flat/recommended'],

  // 关闭 Vue 模板/风格规则（本项目已有统一风格，无需 ESLint 强制格式化）
  {
    rules: {
      'vue/max-attributes-per-line': 'off',
      'vue/html-indent': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/attributes-order': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
    },
  },

  // .vue 文件中 <script> 块使用 TypeScript 解析器
  {
    files: ['*.vue', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
)
