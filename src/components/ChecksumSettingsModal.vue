<script setup lang="ts">
import { computed } from 'vue'
import { NModal, NForm, NFormItem, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/composables/useSession'
import { getDecoder } from '@/decoders'

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

// 接收校验与解码器内置校验的冲突提示：当前解码器自带完整性校验（如 Modbus RTU 内置 CRC16）
// 且接收校验算法与它不一致时，合法帧也会被标「校验失败」。数据驱动护栏——任何声明了
// selfChecksIntegrity + integrityChecksum 的未来解码器自动获得该提示，本组件无需改动。
const integrityConflict = computed(() => {
  const def = session.decoder.id ? getDecoder(session.decoder.id) : undefined
  if (!def?.selfChecksIntegrity || !def.integrityChecksum) return null
  if (checksum.rx === 'none' || checksum.rx === def.integrityChecksum) return null
  return {
    name: def.name,
    algo: t(`checksum.algo.${def.integrityChecksum}`) as string
  }
})
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
      </NForm>
      <div v-if="integrityConflict" class="checksum-warn">
        {{ t('checksum.integrityConflict', { name: integrityConflict.name, algo: integrityConflict.algo }) }}
      </div>
      <div class="checksum-hint">{{ t('checksum.sessionHint') }}</div>
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
.checksum-warn {
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin-top: 2px;
}
:deep(.n-form-item) {
  margin-bottom: 12px;
}
</style>
