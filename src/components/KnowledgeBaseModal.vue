<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NModal, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { KB_ENTRIES } from '@/utils/knowledge-base'

const show = defineModel<boolean>('show', { default: false })

const { t } = useI18n()

// 条目分页：一次展示一条，底部上一页/下一页翻页
const total = KB_ENTRIES.length
const page = ref(0)

watch(
  () => show.value,
  (on) => {
    if (on) page.value = 0 // 每次打开回到第一条
  }
)

const entry = computed(() => KB_ENTRIES[page.value])

function onPrev() {
  page.value = Math.max(0, page.value - 1)
}
function onNext() {
  page.value = Math.min(total - 1, page.value + 1)
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="t('knowBase.title')"
    style="width: 560px"
  >
    <div class="kb">
      <div class="kb-head">
        <div class="kb-title">{{ t(entry.titleKey) }}</div>
        <div v-if="entry.summaryKey" class="kb-summary">{{ t(entry.summaryKey) }}</div>
      </div>
      <div class="kb-body">
        <template v-for="(block, i) in entry.blocks" :key="i">
          <p v-if="block.type === 'text'" class="kb-text">{{ t(block.text ?? '') }}</p>
          <pre v-else-if="block.type === 'code'" class="kb-code"><code>{{ (block.lines ?? []).join('\n') }}</code></pre>
          <table v-else-if="block.type === 'table'" class="kb-table">
            <thead>
              <tr>
                <th v-for="(h, hi) in block.table?.headers ?? []" :key="hi">{{ t(h) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in block.table?.rows ?? []" :key="ri">
                <td v-for="(cell, ci) in row" :key="ci">{{ t(cell) }}</td>
              </tr>
            </tbody>
          </table>
          <a
            v-else
            class="kb-link"
            :href="block.href"
            target="_blank"
            rel="noopener"
          >{{ t(block.text ?? '') }}</a>
        </template>
      </div>
      <div class="kb-foot">
        <NButton size="small" :disabled="page === 0" @click="onPrev">← {{ t('knowBase.prev') }}</NButton>
        <span class="kb-page">{{ page + 1 }} / {{ total }}</span>
        <NButton size="small" :disabled="page === total - 1" @click="onNext">{{ t('knowBase.next') }} →</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.kb {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kb-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kb-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.kb-summary {
  font-size: 12px;
  color: var(--text-dim);
}
.kb-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  /* 固定高度 + 滚动条：翻页时弹窗尺寸保持一致，短条目也占同样空间，长条目滚动 */
  height: 320px;
  overflow-y: auto;
}
/* 滚动容器里的 flex 列：子项一律禁止收缩。带 overflow 的子项（代码块 overflow-x: auto，
 * 另一轴随之按 auto 处理）在 flex 布局下自动最小尺寸为 0，会被压成一行高、内容整段裁掉
 * ——表现为多行代码只剩一条水平滚动条。超高由 .kb-body 滚动，而不是压缩子项。 */
.kb-body > * {
  flex-shrink: 0;
}
.kb-text {
  margin: 0;
}
.kb-code {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--mono-font);
  font-size: 12px;
  line-height: 1.6;
  /* 保留缩进与换行，但长行折行显示：文档里被横向滚动条藏住的部分等于没写出来 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 表格块：长内容按列自动换行，无需横向滚动 */
.kb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.6;
}
.kb-table th,
.kb-table td {
  border: 1px solid var(--border);
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
.kb-table th {
  background: var(--bg-elevated);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.kb-table td {
  color: var(--text);
  word-break: break-word;
}
/* 首列是行标签（信号类别 / 约定名），保持一行不折；说明文字都在后面的列里 */
.kb-table td:first-child {
  white-space: nowrap;
}
/* 中间列按「短标识符」呈现（等宽 + 不换行，见 rs232 信号线表的信号名）；
   末列是说明列，必须允许换行——否则长句会被裁掉半截（2 列表格的第 2 列即末列）。 */
.kb-table td:nth-child(2):not(:last-child) {
  font-family: var(--mono-font);
  white-space: nowrap;
}
.kb-link {
  color: var(--accent);
  text-decoration: none;
  word-break: break-all;
}
.kb-link:hover {
  text-decoration: underline;
}
.kb-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.kb-page {
  font-size: 12px;
  color: var(--text-dim);
}
</style>
