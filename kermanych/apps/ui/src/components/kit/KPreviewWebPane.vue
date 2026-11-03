<template>
  <div class="k-preview-web">
    <KPreviewRow :preview="preview" />
    <div class="k-preview-web__page">
      <p class="k-preview-web__text">{{ t('agents.preview.webOnly') }}</p>
      <KIconButton :title="t('agents.preview.openTab')" :disabled="!url" @click="openTab">⤤</KIconButton>
      <span v-if="url" class="k-preview-web__url mono" v-tip="url">{{ url }}</span>
    </div>
    <KPreviewLogs v-if="logsOpen" :session-id="session.id" :preview="preview" />
  </div>
</template>

<script setup lang="ts">
// The «Браузер» tab of an `agent` session in the web build
// (docs/specs/2026-11-03-session-browser-preview.md, decision 6): the same preview row and logs
// as the desktop pane, and in place of the page — which only the desktop app can embed — a note
// and ⤤ to the running preview in a tab of its own. ▶ opens that tab itself (useSessionPreview).
import { useI18n } from 'vue-i18n';
import type { Session } from '@kermanych/core';
import KIconButton from './KIconButton.vue';
import KPreviewLogs from './KPreviewLogs.vue';
import KPreviewRow from './KPreviewRow.vue';
import { useSessionPreview } from '../../composables/useSessionPreview';

const props = defineProps<{ session: Session }>();

const { t } = useI18n();
const preview = useSessionPreview(() => props.session);
const { url, logsOpen } = preview;

function openTab(): void {
  if (url.value) window.open(url.value, '_blank');
}
</script>

<style scoped lang="scss">
.k-preview-web {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.k-preview-web__page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-3);
  padding: 24px 12px;
  text-align: center;
}
.k-preview-web__text {
  margin: 0;
  max-width: 44ch;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
}
.k-preview-web__url {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}
</style>
