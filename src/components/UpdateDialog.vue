<script setup lang="ts">
import { computed } from 'vue'
import { NModal, NButton, NSpin, NProgress, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useUpdater } from '@/composables/useUpdater'
import { useActiveSession } from '@/composables/useSession'
import { formatBytes, formatSpeed, formatEta } from '@/utils/updater'

const { state, dialogVisible, download, cancelDownload, quitAndInstall, openReleases, check, closeDialog } = useUpdater()
const { t } = useI18n()
const dialog = useDialog()
const activeSession = useActiveSession()

const status = computed(() => state.value.status)
const info = computed(() => state.value.info)
const progress = computed(() => state.value.progress)
// 全局 const（__APP_VERSION__ 等在 env.d.ts 声明）仅在 script 上下文中可解析，
// 模板访问需经 setup 作用域变量桥接（About 弹窗同样经 aboutRows computed 暴露）
const currentVersion = __APP_VERSION__

// macOS 无签名证书时自动更新在下载/安装阶段失败，错误框里给出手动下载提示
const isMac = computed(() => window.electron?.platform === 'darwin')

const releaseDateText = computed(() => {
  const d = info.value?.releaseDate
  if (!d) return ''
  try {
    return new Date(d).toLocaleString()
  } catch {
    return d
  }
})

const title = computed(() => {
  switch (status.value) {
    case 'checking': return t('update.checking')
    case 'available': return t('update.available')
    case 'downloading': return t('update.downloadingTitle')
    case 'downloaded': return t('update.downloadedTitle')
    case 'error': return t('update.checkFailed')
    default: return t('menu.checkUpdate')
  }
})

// ── 重启保护（串口工具特有）：录制/下发活跃时二次确认，避免状态全丢 ──
const recordingStatus = computed(() => activeSession.value.recorder.state.status)
const transferActive = computed(() =>
  activeSession.value.transfer.transfers.some((t) => t.status === 'queued' || t.status === 'sending' || t.status === 'paused')
)

function onRestart(): void {
  const parts: string[] = []
  if (recordingStatus.value !== 'idle') parts.push(t('update.recordingActive'))
  if (transferActive.value) parts.push(t('update.transferActive'))
  if (parts.length === 0) {
    quitAndInstall()
    return
  }
  dialog.warning({
    title: t('update.restartConfirmTitle'),
    content: t('update.restartConfirmContent', { items: parts.join('、') }),
    positiveText: t('update.restartNow'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => quitAndInstall()
  })
}
</script>

<template>
  <NModal v-model:show="dialogVisible" preset="card" :title="title" style="width: 460px">
    <div class="update-body">
      <!-- 检查中 -->
      <div v-if="status === 'checking'" class="row-center">
        <NSpin size="small" />
        <span class="dim">{{ t('update.checking') }}</span>
      </div>

      <!-- 发现新版本 -->
      <template v-else-if="status === 'available' && info">
        <div class="version-row">
          <span class="ver-label">{{ t('update.current') }}</span>
          <span class="ver-code dim">{{ currentVersion }}</span>
          <span class="arrow">→</span>
          <span class="ver-code strong">{{ info.version }}</span>
        </div>
        <div class="meta">
          <span v-if="releaseDateText">{{ t('update.releaseDate') }}: {{ releaseDateText }}</span>
          <span v-if="info.totalSize">{{ t('update.size') }}: {{ formatBytes(info.totalSize) }}</span>
        </div>
        <div v-if="info.releaseNotes" class="notes">
          <div class="notes-title">{{ t('update.releaseNotes') }}</div>
          <!-- 纯文本渲染：releaseNotes 来自远端（GitHub Release body），不经 v-html，规避 CSP/注入 -->
          <pre class="notes-body">{{ info.releaseNotes }}</pre>
        </div>
      </template>

      <!-- 下载中 -->
      <template v-else-if="status === 'downloading' && progress">
        <NProgress type="line" :percentage="progress.percent" :height="8" :show-indicator="false" />
        <div class="dl-meta mono">
          <span>{{ formatBytes(progress.transferred) }} / {{ formatBytes(progress.total) }}</span>
          <span>{{ formatSpeed(progress.bytesPerSecond) }}</span>
          <span>{{ t('update.eta') }} {{ formatEta(progress.transferred, progress.total, progress.bytesPerSecond) }}</span>
        </div>
        <p class="hint">{{ t('update.backgroundHint') }}</p>
      </template>

      <!-- 下载完成 -->
      <template v-else-if="status === 'downloaded'">
        <p class="done">{{ t('update.downloaded') }}</p>
        <!-- macOS 无签名：自动安装大概率失败，不承诺「稍后自动安装」，引导手动下载 -->
        <p v-if="isMac" class="hint">{{ t('update.macDownloadHint') }}</p>
        <p v-else class="hint">{{ t('update.laterHint') }}</p>
      </template>

      <!-- 失败（自动检查的失败保持静默，此态仅手动检查/下载中出错进入） -->
      <template v-else-if="status === 'error'">
        <p class="err mono">{{ state.error }}</p>
        <p v-if="isMac" class="hint">{{ t('update.macUnsigned') }}</p>
      </template>
    </div>

    <template #footer>
      <div class="footer">
        <template v-if="status === 'available'">
          <NButton size="small" @click="closeDialog">{{ t('update.close') }}</NButton>
          <NButton size="small" type="primary" @click="download">{{ t('update.download') }}</NButton>
        </template>
        <template v-else-if="status === 'downloading'">
          <NButton size="small" @click="cancelDownload">{{ t('update.cancelDownload') }}</NButton>
          <NButton size="small" @click="closeDialog">{{ t('update.close') }}</NButton>
        </template>
        <template v-else-if="status === 'downloaded'">
          <template v-if="isMac">
            <!-- mac 无签名：不承诺重启即装，主操作走手动下载 -->
            <NButton size="small" @click="closeDialog">{{ t('update.later') }}</NButton>
            <NButton size="small" type="primary" @click="openReleases">{{ t('update.manualDownload') }}</NButton>
          </template>
          <template v-else>
            <NButton size="small" @click="closeDialog">{{ t('update.later') }}</NButton>
            <NButton size="small" type="primary" @click="onRestart">{{ t('update.restartNow') }}</NButton>
          </template>
        </template>
        <template v-else-if="status === 'error'">
          <NButton size="small" @click="closeDialog">{{ t('update.close') }}</NButton>
          <NButton size="small" @click="openReleases">{{ t('update.manualDownload') }}</NButton>
          <NButton size="small" type="primary" @click="check">{{ t('update.retry') }}</NButton>
        </template>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.update-body {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}
.row-center {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.dim {
  color: var(--text-dim);
}
.version-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ver-label {
  color: var(--text-dim);
}
.ver-code {
  font-family: var(--mono-font);
  font-size: 13px;
}
.ver-code.strong {
  font-weight: 600;
}
.arrow {
  color: var(--text-dim);
}
.meta {
  display: flex;
  gap: 16px;
  color: var(--text-dim);
  font-size: 12px;
}
.notes {
  margin-top: 8px;
}
.notes-title {
  color: var(--text-dim);
  margin-bottom: 2px;
}
.notes-body {
  margin: 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  user-select: text;
}
.dl-meta {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.mono {
  font-family: var(--mono-font);
}
.hint {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
}
.done {
  margin: 0;
}
.err {
  margin: 0;
  color: var(--danger, #e5484d);
  word-break: break-word;
  user-select: text;
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>