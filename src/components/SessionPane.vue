<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ConnectionBar from './ConnectionBar.vue'
import MessageList from './MessageList.vue'
import WaveformChart from './WaveformChart.vue'
import InputComposer from './InputComposer.vue'
import StatusBar from './StatusBar.vue'
import { provideSession } from '@/composables/useSession'
import type { Session } from '@/session'
import type { DataMode } from '@/types'
import type { AsciiEntry } from '@/utils/ascii-table'

const props = defineProps<{ session: Session }>()

const emit = defineEmits<{
  (e: 'open-file-transfer', file?: File): void
}>()

provideSession(props.session)

const { t } = useI18n()

// 会话态 UI（多会话后随 tab 独立）：视图切换 + 发送框内容
const mainView = ref<'messages' | 'waveform'>('messages')
const viewMode = ref<DataMode>(props.session.settings.defaultView)
const composerText = ref('')

const NAMED_ESCAPES = new Set([0, 9, 10, 13])

function onResend(bytes: Uint8Array) {
  props.session.serial.resend(bytes)
}

function onToComposer(p: { text: string; mode: DataMode }) {
  composerText.value = p.text
  viewMode.value = p.mode
}

function onOpenFileTransfer(file?: File) {
  emit('open-file-transfer', file)
}

/** 编码器支持的命名转义（与 encodeWithEscapes 的 switch 保持一致） */
function insertAscii(e: AsciiEntry) {
  if (viewMode.value === 'hex') {
    composerText.value += (composerText.value && !composerText.value.endsWith(' ') ? ' ' : '') + e.hex + ' '
  } else if (e.char != null) {
    composerText.value += e.char
  } else if (e.escape && NAMED_ESCAPES.has(e.dec)) {
    composerText.value += e.escape
  }
}

defineExpose({ insertAscii, toComposer: onToComposer })
</script>

<template>
  <div class="session-pane">
    <ConnectionBar />
    <div class="main">
      <div class="left">
        <div class="view-tabs">
          <button
            class="tab"
            :class="{ active: mainView === 'messages' }"
            @click="mainView = 'messages'"
          >
            {{ t('app.msg') }}
          </button>
          <button
            class="tab"
            :class="{ active: mainView === 'waveform' }"
            @click="mainView = 'waveform'"
          >
            {{ t('app.waveform') }}
          </button>
        </div>

        <MessageList v-show="mainView === 'messages'" :view-mode="viewMode" @resend="onResend" />
        <WaveformChart v-show="mainView === 'waveform'" />
        <InputComposer
          v-model:text="composerText"
          v-model:mode="viewMode"
          @open-file-transfer="onOpenFileTransfer"
        />
      </div>
    </div>
    <StatusBar />
  </div>
</template>

<style scoped>
.session-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.view-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
}
.tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  padding: 7px 16px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
</style>
