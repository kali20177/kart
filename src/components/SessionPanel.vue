<script setup lang="ts">
import SessionPane from './SessionPane.vue'
import type { Session } from '@/session'

/**
 * 根级 dockview 的会话面板内容包装：dockview-vue 把面板参数作为单一 params prop
 * 传入内容组件（结构 { params, api, containerApi, tabLocation }），这里取出
 * addPanel 时的用户 params（Session 对象）转发给 SessionPane。
 */
const props = defineProps<{ params: { params: Session } }>()
</script>

<template>
  <SessionPane :session="props.params.params" />
</template>
