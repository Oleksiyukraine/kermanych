<template>
  <div class="k-session-env">
    <p class="k-session-env__note">{{ session.worktree ? t('agents.preview.envWorktree') : t('agents.preview.envInPlace') }}</p>
    <p v-if="loadError" class="k-session-env__note k-session-env__note--error" role="alert">
      {{ t('agents.preview.envFailed', { error: loadError }) }}
    </p>
    <template v-else>
      <KEnvEditor v-model="rows" :ignored="file?.ignored ?? true" flags-locked :loading="file === null" />
      <p class="k-session-env__note">{{ t('agents.preview.envLocal') }}</p>
      <div class="k-session-env__actions">
        <KBtn variant="primary" :disabled="!dirty" :loading="saveAction.busy.value" @click="saveAction.run()">{{ t('agents.preview.envSave') }}</KBtn>
        <KBtn variant="secondary" :disabled="!dirty || saveAction.busy.value" @click="seed()">{{ t('agents.preview.envCancel') }}</KBtn>
      </div>
      <!-- Dev servers read `.env` when they start: a save under a live preview applies on ↻. -->
      <div v-if="staleRun" class="k-session-env__restart" role="status">
        <span>{{ t('agents.preview.envRestart') }}</span>
        <KBtn :loading="preview.restartAction.busy.value" @click="restart">{{ t('agents.preview.envRestartBtn') }}</KBtn>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// «Змінні» of the preview panel (docs/specs/2026-11-04-session-env-and-tester-preview-gate.md,
// decision 2): the `.env` of the directory this session's preview runs from — its worktree, or
// the project checkout of an in-place session — in the table Settings → «Змінні середовища»
// uses. The required-key pills are the project's shared list and stay locked here. Nothing
// restarts by itself: a save under a running preview offers ↻.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EnvFileView, Session } from '@kermanych/core';
import KBtn from './KBtn.vue';
import KEnvEditor from './KEnvEditor.vue';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { buildEnvRows, envEdits, type EnvRow } from '../../lib/settings';
import type { SessionPreview } from '../../composables/useSessionPreview';

const props = defineProps<{ session: Session; preview: SessionPreview }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();

// null until read; the table is a skeleton meanwhile, so nothing typed is lost to the late load.
const file = ref<EnvFileView | null>(null);
const loadError = ref<string | null>(null);
const rows = ref<EnvRow[]>([]);
const base = ref<EnvRow[]>([]);

function seed(): void {
  const built = buildEnvRows(file.value?.entries ?? [], projects.byId.get(props.session.projectId)?.envKeys ?? []);
  rows.value = built.map((r) => ({ ...r }));
  base.value = built;
}

const dirty = computed(
  () => rows.value.length !== base.value.length || rows.value.some((r, i) => r.key !== base.value[i]?.key || r.value !== base.value[i]?.value),
);

// A save under a live preview: its dev servers still hold the old values until the next start.
// Any new start (↻ here or in the row, the agent's preview_start) or the end of the run clears it.
const needsRestart = ref(false);
watch(props.preview.state, (s, before) => {
  if (!s || (s.phase !== 'running' && s.phase !== 'starting') || (s.phase === 'starting' && before?.phase !== 'starting')) needsRestart.value = false;
});
const staleRun = computed(() => needsRestart.value && props.preview.live.value);

const saveAction = useAsyncAction(async () => {
  const edits = envEdits(rows.value, file.value?.entries ?? []);
  file.value = await store.saveSessionEnv(props.session.id, edits);
  seed();
  needsRestart.value = props.preview.live.value;
  store.notify(t('agents.preview.envSaved'));
});

function restart(): void {
  void props.preview.start(true);
}

void store
  .getSessionEnv(props.session.id)
  .then((view) => {
    file.value = view;
    seed();
  })
  .catch((e: unknown) => {
    loadError.value = errorText(e);
  });
</script>

<style scoped lang="scss">
.k-session-env {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: var(--k-font-ui);
}
.k-session-env__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
.k-session-env__note--error {
  color: var(--k-danger);
}
.k-session-env__actions {
  display: flex;
  gap: 8px;
}
.k-session-env__restart {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}
</style>
