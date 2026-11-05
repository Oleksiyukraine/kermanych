<template>
  <KModal :model-value="modelValue" :title="t('plane.launchDialog.title', { key: issue.key })" width="480px" :persistent="busy" @update:model-value="onToggle">
    <div class="pld">
      <p class="pld__summary">{{ issue.summary }}</p>

      <!-- The defaults depend on the states read: until it answers, the selects would show a
           placeholder that then jumps to a preselection. -->
      <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="2" />
      <template v-else-if="phase === 'ready'">
        <KSelect
          v-model="projectPick"
          :label="t('plane.launchDialog.projectLabel')"
          :options="projectOptions"
          :placeholder="t('plane.launchDialog.projectPlaceholder')"
        />

        <template v-if="defaults.askStatus">
          <KSelect
            v-model="transitionPick"
            :label="t('plane.launchDialog.statusLabel')"
            :options="transitionOptions"
            :placeholder="t('plane.launchDialog.statusPlaceholder')"
          />
        </template>
        <p v-else class="pld__note">
          {{ t('plane.launchDialog.inProgressNote') }}
        </p>
      </template>

      <p v-if="error" class="pld__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('plane.launchDialog.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="!loaded || !projectPick" :loading="busy" @click="launch">
        {{ busy ? t('plane.launchDialog.launching') : t('plane.launchDialog.launch') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The Plane work item's launch: which Kermanych repo runs it, and which Plane state it moves
// to. Preselection is lib/plane-view.launchDefaults — the item's remembered binding, then
// the sidebar's selected project, then the sole project; the state question is hidden for an
// item already in a started state (the agreed «не рухати» rule, Jira's).
import { computed, ref, watch } from 'vue';
import type { PlaneIssue } from '@kermanych/cloud';
import type { Session } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api } from '../../lib/api';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { launchDefaults, type LaunchDefaults, type PlaneTransitionView } from '../../lib/plane-view';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ modelValue: boolean; issue: PlaneIssue; workspaceId: string; integrationId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launched: [session: Session, transitionError?: string];
}>();

const cloud = useProjects();
const local = useOrchestrator();
const { t } = useI18n();

const projectPick = ref('');
const transitionPick = ref('');
const transitions = ref<PlaneTransitionView[]>([]);
const defaults = ref<LaunchDefaults>({ askStatus: false });
const error = ref('');
// The states read for THIS open has answered (or failed): the selects, the defaults and
// «Запустити» wait on it. A run counter drops the answer of an earlier open.
const loaded = ref(false);
let openRun = 0;
const phase = useLoadPhase(() => props.modelValue && !loaded.value);

const workspaceProjects = computed(() => cloud.projects.filter((p) => p.workspaceId === props.workspaceId));

const projectOptions = computed<KSelectOption[]>(() =>
  workspaceProjects.value.map((p) => ({ value: p.id, label: p.name })),
);

const transitionOptions = computed<KSelectOption[]>(() =>
  transitions.value.map((tr) => ({ value: tr.id, label: tr.to.name })),
);

// (Re)armed on every open: the offered states are per-item per-moment, and the defaults
// depend on them AND on the sidebar's current selection.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    const mine = ++openRun;
    // The previous open's picks belong to that moment: reset before the read, so a quick
    // «Запустити» cannot launch with a stale project or state.
    error.value = '';
    transitions.value = [];
    projectPick.value = '';
    transitionPick.value = '';
    defaults.value = { askStatus: false };
    loaded.value = false;
    try {
      const answer = await api.planeTransitions(props.integrationId, props.issue.key);
      if (mine !== openRun) return;
      transitions.value = answer;
    } catch (e) {
      if (mine !== openRun) return;
      // No states is a degraded launch, not a refusal: the session is the point.
      error.value = errorText(e);
    }
    defaults.value = launchDefaults(
      props.issue,
      local.selectedProjectId ?? null,
      workspaceProjects.value,
      transitions.value,
    );
    projectPick.value = defaults.value.projectId ?? '';
    transitionPick.value = defaults.value.transitionId ?? '';
    loaded.value = true;
  },
);

// Short op: the modal stays open (persistent, Cancel blocked) until the session exists, and a
// refusal is shown inside it.
const { run: launch, busy } = useAsyncAction(
  async () => {
    if (!loaded.value || !projectPick.value) return;
    error.value = '';
    const res = await api.planeLaunch(
      props.integrationId,
      props.issue.key,
      projectPick.value,
      defaults.value.askStatus && transitionPick.value ? transitionPick.value : undefined,
    );
    emit('update:modelValue', false);
    emit('launched', res.session, res.transitionError);
  },
  { onError: (e) => (error.value = errorText(e)) },
);

function onToggle(open: boolean): void {
  if (!open && busy.value) return;
  emit('update:modelValue', open);
}
</script>

<style scoped lang="scss">
.pld {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.pld__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.pld__note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.pld__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
