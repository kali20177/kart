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
        <div class="kb-summary">{{ t(entry.summaryKey) }}</div>
      </div>
      <div class="kb-body">
        <template v-for="(block, i) in entry.blocks" :key="i">
          <p v-if="block.type === 'text'" class="kb-text">{{ t(block.text ?? '') }}</p>
          <pre v-else-if="block.type === 'code'" class="kb-code"><code>{{ (block.lines ?? []).join('\n') }}</code></pre>
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
  overflow-x: auto;
  white-space: pre;
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
