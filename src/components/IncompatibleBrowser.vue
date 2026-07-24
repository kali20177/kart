<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { UnsupportedReason } from '@/serial'

const props = defineProps<{ reason: UnsupportedReason | null }>()
const { t } = useI18n()

// reason 为 null 时(switchDriver 手动切换等边缘场景)回退到 no-web-serial 文案
const effectiveReason = computed<UnsupportedReason>(() => props.reason ?? 'no-web-serial')

const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API'

function reload() {
  location.reload()
}
</script>

<template>
  <div class="incompatible-overlay">
    <div class="incompatible-card">
      <svg class="icon" viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
        <path
          fill="currentColor"
          d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"
        />
      </svg>
      <h2 class="title">{{ t('compat.title') }}</h2>
      <p class="desc">
        {{ effectiveReason === 'insecure-context' ? t('compat.insecureContext') : t('compat.noWebSerial') }}
      </p>
      <div class="actions">
        <NButton tag="a" :href="MDN_URL" target="_blank" rel="noopener" tertiary size="small">
          {{ t('compat.learnMore') }}
        </NButton>
        <NButton type="primary" size="small" @click="reload">{{ t('compat.reload') }}</NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.incompatible-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.incompatible-card {
  max-width: 460px;
  margin: 0 24px;
  padding: 32px 28px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  text-align: center;
}
.icon {
  color: var(--accent-cyan);
  margin-bottom: 4px;
}
.title {
  margin: 8px 0 12px;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
}
.desc {
  margin: 0 0 20px;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-line;
}
.actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}
</style>
