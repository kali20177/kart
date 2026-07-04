<script setup lang="ts">
import { NDrawer, NDrawerContent } from 'naive-ui'
import { ASCII_TABLE, type AsciiEntry } from '@/utils/ascii-table'

const show = defineModel<boolean>('show', { default: false })
const emit = defineEmits<{ (e: 'insert', entry: AsciiEntry): void }>()
</script>

<template>
  <NDrawer v-model:show="show" :width="460" placement="right">
    <NDrawerContent
      title="ASCII 对照表"
      closable
      :body-content-style="{ padding: '0 24px 16px' }"
    >
      <p class="tip">点击任意行插入到发送框（按当前 ASCII/HEX 模式）。</p>
      <table class="ascii">
        <thead>
          <tr>
            <th>DEC</th>
            <th>HEX</th>
            <th>OCT</th>
            <th>字符</th>
            <th>名称</th>
            <th>转义</th>
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
