<script setup lang="ts">
import { computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NSelect, NInputNumber, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listDecoders } from '@/decoders'
import type { FieldDecoderOptions, FieldFormat } from '@/decoders'
import { useSession } from '@/composables/useSession'

const show = defineModel<boolean>('show', { default: false })
const { t } = useI18n()
const session = useSession()

// 帧解码配置：会话级（按端口持久化，见 session/index.ts）。直接编辑 session.decoder
// 同一 reactive 对象（就地修改）——session/index.ts 的按端口持久化 watcher 依赖此语义。
const decoder = session.decoder
const fieldOptions = computed<FieldDecoderOptions | null>(() =>
  decoder.id === 'field' ? (decoder.options as unknown as FieldDecoderOptions) : null
)
// 「无」= id 空串（不启用解码），排在首位
const decoderOptions = computed(() => [
  { label: t('decoder.none'), value: '' },
  ...listDecoders().map((d) => ({ label: d.name, value: d.id }))
])
const fieldFormatOptions: Array<{ label: string; value: FieldFormat }> = [
  { label: 'u8', value: 'u8' },
  { label: 'u16 LE', value: 'u16le' },
  { label: 'u16 BE', value: 'u16be' },
  { label: 'u32 LE', value: 'u32le' },
  { label: 'u32 BE', value: 'u32be' },
  { label: 'ASCII', value: 'ascii' },
  { label: 'UTF-8', value: 'utf8' },
  { label: 'HEX', value: 'hex' }
]

function addField() {
  const f = fieldOptions.value
  if (!f) return
  f.fields.push({ name: '', length: 1, format: 'u8' })
}
function removeField(i: number) {
  const f = fieldOptions.value
  if (f) f.fields.splice(i, 1)
}
function setFieldName(i: number, v: string) {
  const f = fieldOptions.value
  if (f) f.fields[i].name = v
}
function setFieldOffset(i: number, v: number | null) {
  const f = fieldOptions.value
  if (f) f.fields[i].offset = v ?? undefined
}
function setFieldLength(i: number, v: number | null) {
  const f = fieldOptions.value
  if (f && v != null) f.fields[i].length = v
}
function setFieldFormat(i: number, v: FieldFormat) {
  const f = fieldOptions.value
  if (f) f.fields[i].format = v
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="t('decoder.title')"
    style="width: 480px; max-width: 92vw"
    :bordered="false"
  >
    <div class="decoder-modal">
      <NForm label-placement="top" size="small">
        <NFormItem :label="t('decoder.kind')">
          <NSelect v-model:value="decoder.id" :options="decoderOptions" />
        </NFormItem>
        <!-- 字段布局解析器配置 -->
        <template v-if="decoder.id === 'field' && fieldOptions">
          <NFormItem :label="t('decoder.headerHex')">
              <NInput
                size="small"
                :value="fieldOptions.header ?? ''"
                :placeholder="t('decoder.headerHexPlaceholder')"
                @update:value="(v: string) => { const o = fieldOptions; if (o) o.header = v.trim() || undefined }"
              />
            </NFormItem>
            <NFormItem :label="t('decoder.fields')">
              <div class="decoder-fields">
                <div v-for="(f, i) in fieldOptions.fields" :key="i" class="decoder-field-row">
                  <NInput size="small" :value="f.name" :placeholder="t('decoder.fieldName')" style="width: 92px" @update:value="(v: string) => setFieldName(i, v)" />
                  <NInputNumber size="small" :value="f.offset ?? null" :placeholder="t('decoder.fieldOffset')" style="width: 66px" @update:value="(v: number | null) => setFieldOffset(i, v)" />
                  <NInputNumber size="small" :value="f.length" :min="1" :max="4096" :placeholder="t('decoder.fieldLength')" style="width: 66px" @update:value="(v: number | null) => setFieldLength(i, v)" />
                  <NSelect size="small" :value="f.format" :options="fieldFormatOptions" style="width: 100px" @update:value="(v: FieldFormat) => setFieldFormat(i, v)" />
                  <NButton size="small" quaternary type="error" @click="removeField(i)">{{ t('decoder.deleteField') }}</NButton>
                </div>
                <NButton size="small" dashed class="add-field-btn" @click="addField">+ {{ t('decoder.addField') }}</NButton>
                <div class="decoder-field-hint">{{ t('decoder.fieldHint') }}</div>
              </div>
            </NFormItem>
          </template>
          <div v-else-if="decoder.id === 'modbus-rtu'" class="empty-hint">{{ t('decoder.modbusHint') }}</div>
      </NForm>
    </div>
  </NModal>
</template>

<style scoped>
.decoder-modal {
  /* 固定内容区高度：切换解码类型（无/字段布局/Modbus）时弹窗尺寸不跳动，
     内部设置项多时纵向滚动；右侧留白避免字段行贴着滚动条 */
  height: 240px;
  overflow-y: auto;
  padding: 2px 8px 4px 0;
}
.decoder-fields {
  width: 100%;
}
.decoder-field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.add-field-btn {
  margin-top: 2px;
}
.decoder-field-hint {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  opacity: 0.85;
}
.empty-hint {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
}
:deep(.n-form-item) {
  margin-bottom: 12px;
}
</style>
