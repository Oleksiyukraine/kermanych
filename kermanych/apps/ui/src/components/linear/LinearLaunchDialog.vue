<template>
  <KModal :model-value="modelValue" :title="t('linear.launchDialog.title', { key: issue.key })" width="480px" @update:model-value="emit('update:modelValue', $event)">
    <div class="lld">
      <p class="lld__summary">{{ issue.title }}</p>

      <KSelect
        v-model="projectPick"
        :label="t('linear.launchDialog.projectLabel')"
        :options="projectOptions"
        :placeholder="t('linear.launchDialog.projectPlaceholder')"
      />

      <template v-if="defaults.askStatus">
        <KSelect
          v-model="transitionPick"
          :label="t('linear.launchDialog.statusLabel')"
          :options="transitionOptions"
          :placeholder="t('linear.launchDialog.statusPlaceholder')"
        />
      </template>
      <p v-else class="lld__note">
        {{ t('linear.launchDialog.inProgressNote') }}
      </p>

      <p v-if="error" class="lld__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ t('linear.launchDialog.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="!projectPick || busy" @click="launch">
        {{ busy ? t('linear.launchDialog.launching') : t('linear.launchDialog.launch') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The Linear ticket's launch: which Kermanych repo runs it, and which Linear state it
// moves to. Preselection is lib/linear-view.launchDefaults — the ticket's remembered
// binding, then the sidebar's selected project, then the sole project; the status question
// is hidden entirely for a ticket already in Linear's started category (the agreed
// «не рухати» rule).
import { computed, ref, watch } from 'vue';
import type { LinearIssue } from '@kermanych/cloud';
import type { Session } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api } from '../../lib/api';
import { launchDefaults, type LinearTransitionView, type LaunchDefaults } from '../../lib/linear-view';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ modelValue: boolean; issue: LinearIssue; workspaceId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launched: [session: Session, transitionError?: string];
}>();

const cloud = useProjects();
const local = useOrchestrator();
const { t } = useI18n();

const projectPick = ref('');
const transitionPick = ref('');
const transitions = ref<LinearTransitionView[]>([]);
const defaults = ref<LaunchDefaults>({ askStatus: false });
const busy = ref(false);
const error = ref('');

const workspaceProjects = computed(() => cloud.projects.filter((p) => p.workspaceId === props.workspaceId));

const projectOptions = computed<KSelectOption[]>(() =>
  workspaceProjects.value.map((p) => ({ value: p.id, label: p.name })),
);

const transitionOptions = computed<KSelectOption[]>(() =>
  transitions.value.map((tr) => ({ value: tr.id, label: tr.to.name })),
);

// (Re)armed on every open: the transitions are per-issue per-moment, and the defaults
// depend on them AND on the sidebar's current selection.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    error.value = '';
    transitions.value = [];
    try {
      transitions.value = await api.linearTransitions(props.workspaceId, props.issue.key);
    } catch (e) {
      // No transitions is a degraded launch, not a refusal: the session is the point.
      error.value = e instanceof Error ? e.message : String(e);
    }
    defaults.value = launchDefaults(
      props.issue,
      local.selectedProjectId ?? null,
      workspaceProjects.value,
      transitions.value,
    );
    projectPick.value = defaults.value.projectId ?? '';
    transitionPick.value = defaults.value.transitionId ?? '';
  },
);

async function launch(): Promise<void> {
  if (!projectPick.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.linearLaunch(
      props.workspaceId,
      props.issue.key,
      projectPick.value,
      defaults.value.askStatus && transitionPick.value ? transitionPick.value : undefined,
    );
    emit('update:modelValue', false);
    emit('launched', res.session, res.transitionError);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.lld {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.lld__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.lld__note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.lld__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
