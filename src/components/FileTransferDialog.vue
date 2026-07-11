<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NModal,
  NButton,
  NSelect,
  NInputNumber,
  NSwitch,
  NDivider,
  NCollapse,
  NCollapseItem,
  useMessage
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSerialStore } from '@/stores/serial'
import { useTransferStore } from '@/stores/transfer'
import type { FileTransferConfig, ChunkFraming, AckMode, LineEnding, TransferPresetId } from '@/types'

const props = defineProps<{
  show: boolean
  /** 拖入的文件（可选） */
  dropFile?: File | null
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'started'): void
}>()

const { t } = useI18n()
const toast = useMessage()
const serial = useSerialStore()
const transferStore = useTransferStore()

// ── 波特率 -> 物理层最大字节速率 ──
// 8N1: 1 起始 + 8 数据 + (parity!=none?1:0) + stopBits bit/字节
const maxBps = computed(() => {
  const o = serial.options
  const bitsPerByte = 1 + o.dataBits + (o.parity !== 'none' ? 1 : 0) + o.stopBits
  return Math.floor(o.baudRate / bitsPerByte)
})

const overBaudLimit = computed(() => bytesPerSecond.value > 0 && bytesPerSecond.value > maxBps.value)

// ── 文件选择 ──
const fileName = ref('')
const fileSize = ref(0)
const fileHandle = ref<File | null>(null)
const fileError = ref('')

// ── 预设 ──
const presetOptions = computed(() => [
  { label: t('fileTransfer.preset.raw'), value: 'raw' as TransferPresetId },
  { label: t('fileTransfer.preset.stm32Isp'), value: 'stm32-isp' as TransferPresetId },
  { label: t('fileTransfer.preset.esp32'), value: 'esp32' as TransferPresetId },
  { label: t('fileTransfer.preset.stress'), value: 'stress' as TransferPresetId },
  { label: t('fileTransfer.preset.custom'), value: 'custom' as TransferPresetId }
])

const selectedPreset = ref<TransferPresetId>('raw')

// ── 配置字段 ──
const chunkSize = ref(0)
const interChunkDelay = ref(0)
const bytesPerSecond = ref(0)
const retries = ref(0)
const framing = ref<ChunkFraming>('raw')
const chunkSuffix = ref<LineEnding>('none')
const waitForAck = ref(false)
const ackMode = ref<AckMode>('any')
const ackByte = ref(0x06)
const ackTimeout = ref(1000)
const startOffset = ref(0)
const repeat = ref(0)
const logEachChunk = ref(false)
const injectCorruptEveryN = ref(0)
const injectSkipAckEveryN = ref(0)

const framingOptions = [
  { label: 'Raw', value: 'raw' as ChunkFraming },
  { label: 'Len-Prefix', value: 'len-prefix' as ChunkFraming },
  { label: 'Seq+CRC', value: 'seq-crc' as ChunkFraming }
]

const ackModeOptions = [
  { label: 'Any', value: 'any' as AckMode },
  { label: 'Byte', value: 'byte' as AckMode },
  { label: 'Echo-CRC', value: 'echo-crc' as AckMode }
]

const suffixOptions = [
  { label: t('composer.none'), value: 'none' as LineEnding },
  { label: '\\r', value: 'cr' as LineEnding },
  { label: '\\n', value: 'lf' as LineEnding },
  { label: '\\r\\n', value: 'crlf' as LineEnding }
]

const chunkSizeOptions = [
  { label: '0 (整包)', value: 0 },
  { label: '64 B', value: 64 },
  { label: '128 B', value: 128 },
  { label: '256 B', value: 256 },
  { label: '512 B', value: 512 },
  { label: '1 KB', value: 1024 },
  { label: '4 KB', value: 4096 },
  { label: '8 KB', value: 8192 }
]

// ── 预设配置映射 ──
const PRESET_CONFIGS: Record<string, Partial<FileTransferConfig>> = {
  raw: { chunkSize: 0, interChunkDelay: 0, bytesPerSecond: 0, retries: 0, framing: 'raw', chunkSuffix: 'none', waitForAck: false, ackMode: 'any', ackByte: 0x06, ackTimeout: 1000, startOffset: 0, repeat: 0, logEachChunk: false, injectCorruptEveryN: 0, injectSkipAckEveryN: 0 },
  'stm32-isp': { chunkSize: 256, interChunkDelay: 10, bytesPerSecond: 0, retries: 3, framing: 'seq-crc', chunkSuffix: 'none', waitForAck: true, ackMode: 'byte', ackByte: 0x06, ackTimeout: 2000, startOffset: 0, repeat: 0, logEachChunk: false, injectCorruptEveryN: 0, injectSkipAckEveryN: 0 },
  esp32: { chunkSize: 4096, interChunkDelay: 5, bytesPerSecond: 0, retries: 2, framing: 'len-prefix', chunkSuffix: 'none', waitForAck: true, ackMode: 'any', ackByte: 0x06, ackTimeout: 3000, startOffset: 0, repeat: 0, logEachChunk: false, injectCorruptEveryN: 0, injectSkipAckEveryN: 0 },
  stress: { chunkSize: 512, interChunkDelay: 20, bytesPerSecond: 0, retries: 3, framing: 'raw', chunkSuffix: 'none', waitForAck: false, ackMode: 'any', ackByte: 0x06, ackTimeout: 1000, startOffset: 0, repeat: 10, logEachChunk: false, injectCorruptEveryN: 0, injectSkipAckEveryN: 0 }
}

// ── 预设切换 ──
watch(selectedPreset, (preset) => {
  if (preset === 'custom') return
  const cfg = PRESET_CONFIGS[preset]
  if (!cfg) return
  chunkSize.value = cfg.chunkSize ?? 0
  interChunkDelay.value = cfg.interChunkDelay ?? 0
  bytesPerSecond.value = cfg.bytesPerSecond ?? 0
  retries.value = cfg.retries ?? 0
  framing.value = cfg.framing ?? 'raw'
  chunkSuffix.value = cfg.chunkSuffix ?? 'none'
  waitForAck.value = cfg.waitForAck ?? false
  ackMode.value = cfg.ackMode ?? 'any'
  ackByte.value = cfg.ackByte ?? 0x06
  ackTimeout.value = cfg.ackTimeout ?? 1000
  startOffset.value = cfg.startOffset ?? 0
  repeat.value = cfg.repeat ?? 0
  logEachChunk.value = cfg.logEachChunk ?? false
  injectCorruptEveryN.value = cfg.injectCorruptEveryN ?? 0
  injectSkipAckEveryN.value = cfg.injectSkipAckEveryN ?? 0
})

// ── 文件大小格式化 ──
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

// ── 文件选择 ──
const fileInput = ref<HTMLInputElement | null>(null)

function onSelectFile() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (!target.files?.length) return
  setFile(target.files[0])
  target.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) {
    setFile(e.dataTransfer.files[0])
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function clearFile() {
  fileHandle.value = null
  fileName.value = ''
  fileSize.value = 0
  fileError.value = ''
}

function setFile(file: File) {
  if (file.size === 0) {
    fileError.value = t('fileTransfer.emptyFile')
    return
  }
  fileError.value = ''
  fileHandle.value = file
  fileName.value = file.name
  fileSize.value = file.size
}

// ── 开始下发 ──
async function onStart() {
  if (!serial.connected) {
    toast.warning(t('fileTransfer.needConnect'))
    return
  }
  if (!fileHandle.value) {
    toast.warning(t('fileTransfer.needFile'))
    return
  }

  const config: FileTransferConfig = {
    chunkSize: chunkSize.value,
    interChunkDelay: interChunkDelay.value,
    bytesPerSecond: bytesPerSecond.value,
    retries: retries.value,
    framing: framing.value,
    chunkSuffix: chunkSuffix.value,
    waitForAck: waitForAck.value,
    ackMode: ackMode.value,
    ackByte: ackByte.value,
    ackTimeout: ackTimeout.value,
    startOffset: startOffset.value,
    repeat: repeat.value,
    logEachChunk: logEachChunk.value,
    injectCorruptEveryN: injectCorruptEveryN.value,
    injectSkipAckEveryN: injectSkipAckEveryN.value
  }

  transferStore.lastConfig = config
  transferStore.lastPreset = selectedPreset.value

  await transferStore.start(fileHandle.value, config)
  toast.success(t('fileTransfer.started'))
  emit('started')
  emit('update:show', false)
}

// ── 可用性 ──
const canStart = computed(() => fileHandle.value !== null)

// ── 从上次配置恢复 ──
watch(
  () => props.show,
  (v) => {
    if (v) {
      // 恢复上次配置
      const cfg = transferStore.lastConfig
      chunkSize.value = cfg.chunkSize
      interChunkDelay.value = cfg.interChunkDelay
      bytesPerSecond.value = cfg.bytesPerSecond
      retries.value = cfg.retries
      framing.value = cfg.framing
      chunkSuffix.value = cfg.chunkSuffix
      waitForAck.value = cfg.waitForAck
      ackMode.value = cfg.ackMode
      ackByte.value = cfg.ackByte
      ackTimeout.value = cfg.ackTimeout
      startOffset.value = cfg.startOffset
      repeat.value = cfg.repeat
      logEachChunk.value = cfg.logEachChunk
      injectCorruptEveryN.value = cfg.injectCorruptEveryN
      injectSkipAckEveryN.value = cfg.injectSkipAckEveryN

      // 恢复预设
      selectedPreset.value = transferStore.lastPreset

      // 如果有拖入的文件
      if (props.dropFile) {
        setFile(props.dropFile)
      }
    }
  }
)
</script>

<template>
  <NModal
    :show="show"
    @update:show="$event => emit('update:show', $event)"
    :mask-closable="false"
    preset="card"
    :style="{ maxWidth: '580px', width: '90vw' }"
    :title="t('fileTransfer.dialogTitle')"
    :bordered="false"
    :segmented="false"
  >
    <!-- 文件选择区 -->
    <div
      class="drop-zone"
      :class="{ 'has-file': fileHandle }"
      @drop="onDrop"
      @dragover="onDragOver"
      @click="onSelectFile"
    >
      <div v-if="!fileHandle" class="drop-hint">
        <span class="drop-icon">📎</span>
        <span>{{ t('fileTransfer.dropHint') }}</span>
        <span class="drop-sub">{{ t('fileTransfer.orClick') }}</span>
      </div>
      <div v-else class="file-info">
        <span class="drop-icon">📄</span>
        <span class="file-name">{{ fileName }}</span>
        <span class="file-size">{{ fmtBytes(fileSize) }}</span>
        <button class="file-clear" :title="t('fileTransfer.clearFile')" @click.stop="clearFile">×</button>
      </div>
      <input
        ref="fileInput"
        type="file"
        class="file-input-hidden"
        @change="onFileChange"
        accept="*"
      />
    </div>
    <div v-if="fileError" class="file-error">{{ fileError }}</div>

    <NDivider />

    <!-- 预设选择 -->
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.preset') }}</span>
      <NSelect
        v-model:value="selectedPreset"
        :options="presetOptions"
        size="small"
        style="width: 200px"
      />
    </div>

    <NDivider />

    <!-- 分包设置 -->
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.chunkSize') }}</span>
      <NSelect
        v-model:value="chunkSize"
        :options="chunkSizeOptions"
        size="small"
        style="width: 160px"
      />
    </div>
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.interChunkDelay') }}</span>
      <NInputNumber v-model:value="interChunkDelay" :min="0" :step="10" size="small" style="width: 120px">
        <template #suffix>ms</template>
      </NInputNumber>
    </div>
    <div class="field-row">
      <span class="field-label" :title="t('fileTransfer.bytesPerSecondTip')">{{ t('fileTransfer.bytesPerSecond') }}</span>
      <NInputNumber v-model:value="bytesPerSecond" :min="0" :step="100" size="small" style="width: 140px" :placeholder="t('fileTransfer.bytesPerSecondPlaceholder')">
        <template #suffix>B/s</template>
      </NInputNumber>
      <span class="field-hint" :class="{ warn: overBaudLimit }">
        <template v-if="overBaudLimit">⚠ {{ t('fileTransfer.overBaudLimit', { max: maxBps }) }}</template>
        <template v-else>{{ t('fileTransfer.baudLimit', { max: maxBps }) }}</template>
      </span>
    </div>
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.framing') }}</span>
      <NSelect v-model:value="framing" :options="framingOptions" size="small" style="width: 160px" />
    </div>
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.chunkSuffix') }}</span>
      <NSelect v-model:value="chunkSuffix" :options="suffixOptions" size="small" style="width: 120px" />
    </div>

    <!-- 协议设置 -->
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.waitForAck') }}</span>
      <NSwitch v-model:value="waitForAck" size="small" />
    </div>
    <template v-if="waitForAck">
      <div class="field-row sub">
        <span class="field-label">{{ t('fileTransfer.ackMode') }}</span>
        <NSelect v-model:value="ackMode" :options="ackModeOptions" size="small" style="width: 160px" />
      </div>
      <div class="field-row sub">
        <span class="field-label">{{ t('fileTransfer.ackByte') }}</span>
        <NInputNumber v-model:value="ackByte" :min="0" :max="255" size="small" style="width: 100px">
          <template #suffix>0x{{ ackByte.toString(16).padStart(2, '0').toUpperCase() }}</template>
        </NInputNumber>
      </div>
      <div class="field-row sub">
        <span class="field-label">{{ t('fileTransfer.ackTimeout') }}</span>
        <NInputNumber v-model:value="ackTimeout" :min="100" :step="100" size="small" style="width: 120px">
          <template #suffix>ms</template>
        </NInputNumber>
      </div>
      <div class="field-row sub">
        <span class="field-label">{{ t('fileTransfer.retries') }}</span>
        <NInputNumber v-model:value="retries" :min="0" :max="20" size="small" style="width: 100px">
          <template #suffix>{{ t('fileTransfer.retriesUnit') }}</template>
        </NInputNumber>
      </div>
    </template>

    <!-- 鲁棒性设置 -->
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.repeat') }}</span>
      <NInputNumber v-model:value="repeat" :min="0" :max="1000" size="small" style="width: 120px">
        <template #suffix>{{ t('fileTransfer.times') }}</template>
      </NInputNumber>
    </div>
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.startOffset') }}</span>
      <NInputNumber v-model:value="startOffset" :min="0" :step="256" size="small" style="width: 140px">
        <template #suffix>B</template>
      </NInputNumber>
    </div>
    <div class="field-row">
      <span class="field-label">{{ t('fileTransfer.logEachChunk') }}</span>
      <NSwitch v-model:value="logEachChunk" size="small" />
    </div>

    <!-- 高级（折叠） -->
    <NCollapse :default-expanded-names="[]">
      <NCollapseItem :title="t('fileTransfer.advanced')" name="advanced">
        <div class="field-row">
          <span class="field-label">{{ t('fileTransfer.injectCorrupt') }}</span>
          <NInputNumber v-model:value="injectCorruptEveryN" :min="0" :step="5" size="small" style="width: 120px">
            <template #suffix>{{ t('fileTransfer.everyNPackets') }}</template>
          </NInputNumber>
        </div>
        <div class="field-row">
          <span class="field-label">{{ t('fileTransfer.injectSkipAck') }}</span>
          <NInputNumber v-model:value="injectSkipAckEveryN" :min="0" :step="5" size="small" style="width: 120px">
            <template #suffix>{{ t('fileTransfer.everyNPackets') }}</template>
          </NInputNumber>
        </div>
      </NCollapseItem>
    </NCollapse>

    <template #footer>
      <div class="dialog-footer">
        <NButton @click="emit('update:show', false)">{{ t('fileTransfer.cancel') }}</NButton>
        <NButton type="primary" :disabled="!canStart" @click="onStart">
          {{ t('fileTransfer.start') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.drop-zone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  padding: 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.drop-zone:hover {
  border-color: var(--accent);
  background: var(--bg-elevated);
}

.drop-zone.has-file {
  border-style: solid;
  border-color: var(--accent);
  background: var(--bg-elevated);
}

.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 14px;
}

.drop-icon {
  font-size: 28px;
  margin-bottom: 4px;
}

.drop-sub {
  font-size: 12px;
  color: var(--text-dim);
}

.file-info {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
}

.file-name {
  font-weight: 600;
  font-size: 14px;
}

.file-size {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono-font);
}

.file-clear {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 16px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
  transition: color 0.15s, border-color 0.15s;
}

.file-clear:hover {
  color: var(--err);
  border-color: var(--err);
}

.file-input-hidden {
  display: none;
}

.file-error {
  color: var(--err);
  font-size: 12px;
  margin-top: 4px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.field-row.sub {
  padding-left: 20px;
}

.field-label {
  font-size: 13px;
  color: var(--text);
  min-width: 120px;
  flex-shrink: 0;
}

.field-hint {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono-font);
}

.field-hint.warn {
  color: var(--warn);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>