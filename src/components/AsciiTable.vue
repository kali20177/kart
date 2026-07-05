<script setup lang="ts">
import { NDrawer, NDrawerContent } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { ASCII_TABLE, type AsciiEntry } from '@/utils/ascii-table'

const show = defineModel<boolean>('show', { default: false })
const emit = defineEmits<{ (e: 'insert', entry: AsciiEntry): void }>()
const { t } = useI18n()
</script>

<template>
  <NDrawer v-model:show="show" :width="460" placement="right">
    <NDrawerContent
      :title="t('ascii.title')"
      closable
      :body-content-style="{ padding: '0 24px 16px' }"
    >
      <p class="tip">{{ t('ascii.tip') }}</p>
      <table class="ascii">
        <thead>
          <tr>
            <th>{{ t('ascii.dec') }}</th>
            <th>{{ t('ascii.hex') }}</th>
            <th>{{ t('ascii.oct') }}</th>
            <th>{{ t('ascii.char') }}</th>
            <th>{{ t('ascii.name') }}</th>
            <th>{{ t('ascii.escape') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in ASCII_TABLE"
            :key="e.dec"
            :class="{ ctrl: e.control }"
            @click="emit('insert', e)"
          >
            <td>{{ e.dec }}</td>
            <td class="mono">{{ e.hex }}</td>
            <td class="mono">{{ e.oct }}</td>
            <td class="mono char">{{ e.char ?? '' }}</td>
            <td>{{ e.name }}</td>
            <td class="mono">{{ e.escape ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.tip {
  font-size: 12px;
  color: var(--text-dim);
  margin: 12px 0 10px;
}
table.ascii {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}
th,
td {
  text-align: left;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-panel);
  color: var(--text-dim);
  box-shadow: inset 0 -1px 0 var(--border);
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover {
  background: var(--bg-elevated);
}
tr.ctrl {
  color: var(--text-dim);
}
.mono {
  font-family: var(--mono-font);
}
.char {
  font-weight: 600;
}
</style>
