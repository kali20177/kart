<script setup lang="ts">
import MessageList from './MessageList.vue'
import InputComposer from './InputComposer.vue'
import { useSession, useOpenFileTransfer } from '@/composables/useSession'

/**
 * 消息面板 = 消息列表 + 发送框。
 * 发送框属于消息面板：随面板一起显示/隐藏/移动——拖拽布局时它始终贴在消息面板
 * 底部，而非整个会话底部；切到波形/终端 tab 或关闭消息面板时发送框一并消失。
 */
const session = useSession()
const openFileTransfer = useOpenFileTransfer()
</script>

<template>
  <div class="message-panel">
    <div class="list-area">
      <MessageList />
    </div>
    <InputComposer
      v-model:text="session.composerText"
      v-model:mode="session.viewMode"
      @open-file-transfer="openFileTransfer"
    />
  </div>
</template>

<style scoped>
.message-panel {
  display: flex;
  flex-direction: column;
  /* dockview 下父容器（.dv-vue-part）是 block 非 flex，flex:1 不生效，须显式定高 */
  height: 100%;
  min-height: 0;
}
.list-area {
  flex: 1;
  min-height: 0;
  display: flex;
}
.list-area :deep(.list-wrap) {
  width: 100%;
}
</style>
