<script setup lang="ts">
import { computed } from 'vue'
import { NModal, NForm, NFormItem, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/composables/useSession'

const show = defineModel<boolean>('show', { default: false })
const { t } = useI18n()
const session = useSession()

// 校验和配置：会话级（按端口持久化，见 session/index.ts）。直接编辑 session.checksum
// 同一 reactive 对象（就地修改）——session/index.ts 的按端口持久化 watcher 依赖此语义。
const checksum = session.checksum
const checksumAlgoOptions = computed(() => [
  { label: t('checksum.algo.none'), value: 'none' },
  { label: t('checksum.algo.sum8'), value: 'sum8' },
  { label: t('checksum.algo.xor8'), value: 'xor8' },
  { label: t('checksum.algo.crc16-modbus'), value: 'crc16-modbus' },
  { label: t('checksum.algo.crc32'), value: 'crc32' }
])
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="t('checksum.title')"
    style="width: 400px; max-width: 92vw"
    :bordered="false"
  >
    <div class="checksum-modal">
      <NForm label-placement="top" size="small">
        <NFormItem :label="t('checksum.txDefault')">
          <NSelect v-model:value="checksum.send" :options="checksumAlgoOptions" />
        </NFormItem>
        <NFormItem :label="t('checksum.rxAlgorithm')">
          <NSelect v-model:value="checksum.rx" :options="checksumAlgoOptions" />
        </NFormItem>
        <div class="checksum-hint">{{ t('checksum.sessionHint') }}</div>
      </NForm>
    </div>
  </NModal>
</template>

<style scoped>
.checksum-modal {
  padding: 2px 8px 4px 0;
}
.checksum-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  opacity: 0.85;
  margin-top: 4px;
}
:deep(.n-form-item) {
  margin-bottom: 12px;
}
</style>
