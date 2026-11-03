<template>
  <div class="k-preview-row" role="group" :aria-label="t('agents.preview.rowAria')">
    <div class="k-preview-row__main">
      <template v-if="status">
        <KSpinner v-if="status.tone === 'busy'" class="k-preview-row__mark" :size="10" />
        <span v-else class="k-preview-row__dot" :class="`k-preview-row__dot--${status.tone}`" aria-hidden="true"></span>
        <span class="k-preview-row__text" :class="{ 'k-preview-row__text--error': status.tone === 'error' }" v-tip="statusText" aria-live="polite">
          {{ statusText }}
        </span>
      </template>
      <span v-else-if="configError" class="k-preview-row__text k-preview-row__text--error" v-tip="configError">
        {{ t('agents.preview.status.readFailed', { error: configError }) }}
      </span>
      <KSkeleton v-else-if="configPhase === 'skeleton'" variant="line" width="160px" />
      <span v-for="s in services" :key="s.name" class="k-preview-row__chip mono">{{ s.name }} :{{ s.port }}</span>
    </div>
    <div class="k-preview-row__actions">
      <KBtn
        v-if="needsConfig"
        :loading="configureAction.busy.value"
        :title="t('agents.preview.configureTip')"
        @click="configureAction.run()"
      >{{ t('agents.preview.configure') }}</KBtn>
      <template v-if="live">
        <KIconButton
          :title="t('agents.preview.stop')"
          :loading="stopAction.busy.value"
          :disabled="restartAction.busy.value"
          @click="stopAction.run()"
        >◼</KIconButton>
        <KIconButton
          :title="t('agents.preview.restart')"
          :loading="restartAction.busy.value"
          :disabled="stopAction.busy.value || !configOk"
          @click="start(true)"
        >↻</KIconButton>
      </template>
      <KIconButton
        v-else
        :title="t('agents.preview.start')"
        :loading="startAction.busy.value"
        :disabled="!configOk"
        @click="start()"
      >▶</KIconButton>
      <button
        type="button"
        class="k-preview-row__btn"
        :class="{ 'k-preview-row__btn--on': logsOpen }"
        :disabled="!state"
        :aria-pressed="logsOpen"
        @click="toggleLogs"
      >{{ t('agents.preview.logs') }}</button>
    </div>
    <p v-if="configureError" class="k-preview-row__error" role="alert">{{ configureError }}</p>
  </div>
</template>

<script setup lang="ts">
// The preview row of the «Браузер» tab (docs/specs/2026-11-03-session-browser-preview.md,
// decision 6): under the browser toolbar, moving with the pane into «Поруч із логом» — and the
// whole tab in the web build. The status, the service chips, ▶ / ◼ / ↻, «Логи», and
// «Доручити агенту» while the file is missing or broken (the row exists for `agent` sessions
// only, the ones that may be asked). ◼ and a crash leave the page as it is.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from './KBtn.vue';
import KIconButton from './KIconButton.vue';
import KSkeleton from './KSkeleton.vue';
import KSpinner from './KSpinner.vue';
import type { SessionPreview } from '../../composables/useSessionPreview';

const props = defineProps<{ preview: SessionPreview }>();

const { t } = useI18n();
// One instance per pane, handed down unchanged: destructuring keeps the refs reactive.
const {
  state,
  live,
  status,
  config,
  configError,
  configPhase,
  configOk,
  logsOpen,
  toggleLogs,
  start,
  startAction,
  restartAction,
  stopAction,
  configureAction,
  configureError,
} = props.preview;

const statusText = computed(() => (status.value ? t(`agents.preview.status.${status.value.key}`, status.value.params) : ''));
const services = computed(() => (state.value?.phase === 'starting' || state.value?.phase === 'running' ? state.value.services : []));
const needsConfig = computed(() => config.value?.kind === 'missing' || config.value?.kind === 'invalid');
</script>

<style scoped lang="scss">
.k-preview-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-height: 40px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}

.k-preview-row__main {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.k-preview-row__mark {
  color: var(--k-muted);
}
.k-preview-row__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--k-faint);
}
.k-preview-row__dot--ok { background: var(--k-success); }
.k-preview-row__dot--error { background: var(--k-danger); }

.k-preview-row__text {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}
.k-preview-row__text--error {
  color: var(--k-danger);
}

.k-preview-row__chip {
  flex: none;
  padding: 1px 6px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
}

.k-preview-row__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.k-preview-row__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  white-space: nowrap;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
.k-preview-row__btn--on {
  color: var(--k-on-accent);
  background: var(--k-accent);
  border-color: var(--k-accent);
}

.k-preview-row__error {
  flex-basis: 100%;
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-danger);
  overflow-wrap: anywhere;
}
</style>
