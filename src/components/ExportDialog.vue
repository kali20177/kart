<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NSelect,
  NRadioGroup,
  NRadio,
  NCheckbox,
  NInput,
  NButton,
  NSpace,
  NDivider,
  useMessage
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Message, ExportPreferences } from '@/types'
import { useSession } from '@/composables/useSession'
import { storage } from '@/composables/useStorage'
import { formatMessageLine, computeDeltas } from '@/utils/message-format'
import { exportMessagesAsCsv } from '@/utils/export-csv'
import { exportMessagesAsJson, type SessionMeta } from '@/utils/export-json'
import { downloadTextFile, downloadBinaryFile } from '@/utils/download'
import { concatBytes } from '@/utils/encoding'

const props = defineProps<{
  messages: Message[]
  selectedMessages?: Message[]
  defaultScope?: 'all' | 'selected'
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()
const { serial: serialStore, messages: messagesStore, settings: settingsStore } = useSession()
const toast = useMessage()

type ExportFormat = 'txt' | 'csv' | 'json' | 'binary'
type DirectionFilter = 'all' | 'rx' | 'tx'
type TimeStyleVal = 'full' | 'short' | 'none'

const DEFAULT_PREFS: ExportPreferences = {
  format: 'csv',
  direction: 'all',
  dataMode: 'ascii',
  timeStyle: 'full',
  showFrameNum: true,
  showDelta: true,
  showByteCount: true,
  showElapsed: false,
  showError: true,
  includeDividers: false,
  includeNotes: false
}

const saved = storage.get<ExportPreferences>('export-preferences', DEFAULT_PREFS)

const format = ref<ExportFormat>(saved.format ?? DEFAULT_PREFS.format)
const scope = ref<'all' | 'selected'>(props.defaultScope === 'selected' && props.selectedMessages?.length ? 'selected' : 'all')
const direction = ref<DirectionFilter>(saved.direction ?? DEFAULT_PREFS.direction)
const dataMode = ref<'ascii' | 'hex'>(saved.dataMode ?? DEFAULT_PREFS.dataMode)
const timeStyle = ref<TimeStyleVal>(saved.timeStyle ?? DEFAULT_PREFS.timeStyle)
const showFrameNum = ref(saved.showFrameNum ?? DEFAULT_PREFS.showFrameNum)
const showDelta = ref(saved.showDelta ?? DEFAULT_PREFS.showDelta)
const showByteCount = ref(saved.showByteCount ?? DEFAULT_PREFS.showByteCount)
const showElapsed = ref(saved.showElapsed ?? DEFAULT_PREFS.showElapsed)
const showError = ref(saved.showError ?? DEFAULT_PREFS.showError)
const includeDividers = ref(saved.includeDividers ?? false)
const includeNotes = ref(saved.includeNotes ?? false)

const formatOptions = computed(() => [
  { label: 'TXT', value: 'txt' as const },
  { label: 'CSV', value: 'csv' as const },
  { label: 'JSON', value: 'json' as const },
  { label: t('export.formatBin'), value: 'binary' as const }
])

const directionOptions = computed(() => [
  { label: t('export.directionAll'), value: 'all' as const },
  { label: 'RX', value: 'rx' as const },
  { label: 'TX', value: 'tx' as const }
])

const timeStyleOptions = computed(() => [
  { label: t('export.timeFull'), value: 'full' as const },
  { label: t('export.timeShort'), value: 'short' as const },
  { label: t('export.timeNone'), value: 'none' as const }
])

const isTxt = computed(() => format.value === 'txt')
const isCsv = computed(() => format.value === 'csv')
const isJson = computed(() => format.value === 'json')
const isBinary = computed(() => format.value === 'binary')
const showTextOptions = computed(() => isTxt.value || isCsv.value || isJson.value)

/** 按方向和范围过滤后的消息 */
const filteredMessages = computed<Message[]>(() => {
  let list = scope.value === 'selected' && props.selectedMessages ? props.selectedMessages : props.messages
  // 分隔线是结构性标记（direction='tx' 仅为占位），不受方向过滤影响
  if (direction.value === 'rx') list = list.filter((m) => m.kind === 'divider' || m.direction === 'rx')
  else if (direction.value === 'tx') list = list.filter((m) => m.kind === 'divider' || m.direction === 'tx')
  return list
})

const messageCount = computed(() => filteredMessages.value.length)

/** 按用户偏好过滤后的导出消息（排除分隔线 / 剥离标注） */
const filteredForExport = computed<Message[]>(() => {
  let list = filteredMessages.value
  if (!includeDividers.value) {
    // 排除分隔线后，剩余消息均为普通帧 / 文件帧，可无条件根据 includeNotes 剥离标注
    list = includeNotes.value ? list : list.map((m) => ({ ...m, note: undefined }))
  } else {
    // 分隔线保留：其 note 用作标签（非用户标注），不参与 includeNotes 剥离
    list = includeNotes.value ? list : list.map((m) => m.kind === 'divider' ? m : { ...m, note: undefined })
  }
  return list
})

/** 生成的文件名 */
const defaultFilename = computed(() => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const ext = format.value === 'binary' ? 'bin' : format.value
  return `serial-log-${stamp}.${ext}`
})

const filename = ref(defaultFilename.value)

// 格式变化时更新文件扩展名
watch(format, () => {
  const base = filename.value.replace(/\.\w+$/, '')
  const ext = format.value === 'binary' ? 'bin' : format.value
  filename.value = `${base}.${ext}`
})

/** 预览前三行 */
const previewLines = computed(() => {
  const list = filteredForExport.value.slice(0, 3)
  if (list.length === 0) return [t('export.emptyWarn')]

  if (isTxt.value) {
    const deltas = computeDeltas(list)
    return list.map((m, i) =>
      formatMessageLine(m, {
        viewMode: dataMode.value,
        encoding: settingsStore.encoding,
        timeStyle: timeStyle.value,
        withFrameNumber: showFrameNum.value,
        withByteCount: showByteCount.value,
        withDeltaMs: showDelta.value,
        withElapsed: showElapsed.value,
        withError: showError.value,
        frameNumber: i + 1,
        deltaMs: deltas.get(m.id)?.deltaMs,
        elapsedMs: deltas.get(m.id)?.elapsedMs
      })
    )
  }

  if (isCsv.value) {
    const lines = exportMessagesAsCsv(list, { encoding: settingsStore.encoding, dataMode: dataMode.value }).split('\n')
    return lines.filter((l) => l.trim()).slice(0, 4) // header + 3 rows
  }

  if (isJson.value) {
    const meta: SessionMeta = {
      port: serialStore.selectedPort,
      baudRate: serialStore.options.baudRate,
      connectedAt: serialStore.sessionStartedAt,
      encoding: settingsStore.encoding,
      dataMode: dataMode.value,
      totalRxBytes: serialStore.rxBytes,
      totalTxBytes: serialStore.txBytes,
      totalRxFrames: messagesStore.rxFrames,
      totalTxFrames: messagesStore.txFrames
    }
    const json = exportMessagesAsJson(list, meta)
    return json.split('\n').slice(0, 20)
  }

  // binary: show summary (排除分隔线，它们无字节数据)
  const binaryList = list.filter((m) => m.kind !== 'divider')
  const totalBytes = binaryList.reduce((sum, m) => sum + m.bytes.length, 0)
  return [`[Binary] ${binaryList.length} frames, ${totalBytes} total bytes`]
})

function savePreferences() {
  storage.set('export-preferences', {
    format: format.value,
    direction: direction.value,
    dataMode: dataMode.value,
    timeStyle: timeStyle.value,
    showFrameNum: showFrameNum.value,
    showDelta: showDelta.value,
    showByteCount: showByteCount.value,
    showElapsed: showElapsed.value,
    showError: showError.value,
    includeDividers: includeDividers.value,
    includeNotes: includeNotes.value
  })
}

// 偏好随改动即时持久化：下次打开即恢复上次选择，而非仅在完成导出时才保存
// （否则改了格式却取消/关闭，选择会丢失，回落到上次成功导出的格式）
watch(
  [format, direction, dataMode, timeStyle, showFrameNum, showDelta, showByteCount, showElapsed, showError, includeDividers, includeNotes],
  savePreferences
)

const showExport = ref(true)

function handleClose() {
  showExport.value = false
}

function handleAfterLeave() {
  emit('close')
}

function doExport() {
  const list = filteredForExport.value
  if (list.length === 0) {
    toast.warning(t('export.emptyWarn'))
    return
  }

  if (isTxt.value) {
    const deltas = computeDeltas(list)
    const lines =
      list
        .map((m, i) =>
          formatMessageLine(m, {
            viewMode: dataMode.value,
            encoding: settingsStore.encoding,
            timeStyle: timeStyle.value,
            withFrameNumber: showFrameNum.value,
            withByteCount: showByteCount.value,
            withDeltaMs: showDelta.value,
            withElapsed: showElapsed.value,
            withError: showError.value,
            frameNumber: i + 1,
            deltaMs: deltas.get(m.id)?.deltaMs,
            elapsedMs: deltas.get(m.id)?.elapsedMs
          })
        )
        .join('\n') + '\n'
    downloadTextFile(filename.value, lines)
  } else if (isCsv.value) {
    const csv = exportMessagesAsCsv(list, { encoding: settingsStore.encoding, dataMode: dataMode.value })
    downloadTextFile(filename.value, csv)
  } else if (isJson.value) {
    const meta: SessionMeta = {
      port: serialStore.selectedPort,
      baudRate: serialStore.options.baudRate,
      connectedAt: serialStore.sessionStartedAt,
      encoding: settingsStore.encoding,
      dataMode: dataMode.value,
      totalRxBytes: serialStore.rxBytes,
      totalTxBytes: serialStore.txBytes,
      totalRxFrames: messagesStore.rxFrames,
      totalTxFrames: messagesStore.txFrames
    }
    const json = exportMessagesAsJson(list, meta)
    downloadTextFile(filename.value, json)
  } else if (isBinary.value) {
    const allBytes: Uint8Array[] = list
      .filter((m) => m.kind !== 'divider')
      .map((m) => m.bytes)
      .filter((b) => b.length > 0)
    const merged = allBytes.length > 0 ? concatBytes(...allBytes) : new Uint8Array(0)
    downloadBinaryFile(filename.value, merged)
  }

  emit('close')
}
</script>

<template>
  <NModal
    v-model:show="showExport"
    preset="card"
    :title="t('export.title')"
    style="width: 520px"
    :mask-closable="false"
    @update:show="(v: boolean) => !v && handleClose()"
    @after-leave="handleAfterLeave"
  >
    <NForm label-placement="left" label-width="90" size="small">
      <!-- 格式 -->
      <NFormItem :label="t('export.format')">
        <NSelect v-model:value="format" :options="formatOptions" style="width: 140px" />
      </NFormItem>

      <!-- 范围 -->
      <NFormItem :label="t('export.scope')">
        <NRadioGroup v-model:value="scope">
          <NRadio value="all">{{ t('export.scopeAll', { n: props.messages.length }) }}</NRadio>
          <NRadio v-if="props.selectedMessages?.length" value="selected">
            {{ t('export.scopeSelected', { n: props.selectedMessages.length }) }}
          </NRadio>
        </NRadioGroup>
      </NFormItem>

      <!-- 方向 -->
      <NFormItem v-if="!isBinary" :label="t('export.direction')">
        <NSelect v-model:value="direction" :options="directionOptions" style="width: 120px" />
      </NFormItem>

      <!-- TXT/CSV 选项 -->
      <template v-if="showTextOptions">
        <NDivider style="margin: 8px 0" />
        <NFormItem :label="t('export.dataMode')">
          <NRadioGroup v-model:value="dataMode">
            <NRadio value="ascii">ASCII</NRadio>
            <NRadio value="hex">HEX</NRadio>
          </NRadioGroup>
        </NFormItem>
        <NFormItem v-if="isTxt" :label="t('export.timeStyle')">
          <NRadioGroup v-model:value="timeStyle">
            <NRadio v-for="opt in timeStyleOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</NRadio>
          </NRadioGroup>
        </NFormItem>
      </template>

      <!-- TXT 额外字段 -->
      <template v-if="isTxt">
        <NFormItem :label="t('export.extraFields')">
          <NSpace>
            <NCheckbox v-model:checked="showFrameNum">{{ t('export.fieldFrameNum') }}</NCheckbox>
            <NCheckbox v-model:checked="showDelta">Δt</NCheckbox>
            <NCheckbox v-model:checked="showByteCount">{{ t('export.fieldByteCount') }}</NCheckbox>
            <NCheckbox v-model:checked="showElapsed">{{ t('export.fieldElapsed') }}</NCheckbox>
            <NCheckbox v-model:checked="showError">{{ t('export.fieldError') }}</NCheckbox>
          </NSpace>
        </NFormItem>
      </template>

      <!-- 分隔线／标注选项 -->
      <template v-if="!isBinary">
        <NDivider style="margin: 8px 0" />
        <NFormItem :label="t('export.extraContent')">
          <NSpace>
            <NCheckbox v-model:checked="includeDividers">{{ t('export.includeDividers') }}</NCheckbox>
            <NCheckbox v-model:checked="includeNotes">{{ t('export.includeNotes') }}</NCheckbox>
          </NSpace>
        </NFormItem>
      </template>

      <!-- 预览 -->
      <NDivider style="margin: 8px 0" />
      <NFormItem :label="t('export.preview') + ` (${messageCount} ${t('msgList.frames')})`">
        <div class="preview-scroll">
          <pre class="preview-box"><code>{{ previewLines.join('\n') }}</code></pre>
        </div>
      </NFormItem>

      <!-- 文件名 -->
      <NFormItem :label="t('export.filename')">
        <NInput v-model:value="filename" style="width: 100%" />
      </NFormItem>
    </NForm>

    <template #footer>
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <NButton @click="emit('close')">{{ t('export.cancel') }}</NButton>
        <NButton type="primary" @click="doExport">{{ t('export.exportBtn') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.preview-scroll {
  max-height: 140px;
  width: 100%;
  overflow: auto;
}
.preview-box {
  margin: 0;
  padding: 8px;
  font-family: var(--mono-font);
  font-size: 12px;
  line-height: 1.5;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  white-space: pre;
  overflow-x: auto;
  color: var(--text);
}
</style>
