<template>
  <KModal :model-value="modelValue" :title="`Запустити ${issue.key}`" width="480px" @update:model-value="emit('update:modelValue', $event)">
    <div class="jld">
      <p class="jld__summary">{{ issue.summary }}</p>

      <KSelect
        v-model="projectPick"
        label="Проєкт Керманича (репозиторій)"
        :options="projectOptions"
        placeholder="вибрати проєкт…"
      />

      <template v-if="defaults.askStatus">
        <KSelect
          v-model="transitionPick"
          label="Перенести тікет у статус"
          :options="transitionOptions"
          placeholder="— не переносити —"
        />
      </template>
      <p v-else class="jld__note">
        Тікет уже «в роботі» у Jira — статус не змінюємо.
      </p>

      <p v-if="error" class="jld__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">Скасувати</KBtn>
      <KBtn variant="primary" :disabled="!projectPick || busy" @click="launch">
        {{ busy ? 'Запускаємо…' : 'Запустити' }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The Jira ticket's launch: which Kermanych repo runs it, and which Jira status it moves
// to. Preselection is lib/jira-view.launchDefaults — the ticket's remembered binding,
// then the sidebar's selected project, then the sole project; the status question is
// hidden entirely for a ticket already in Jira's In-Progress category (the agreed
// «не рухати» rule).
import { computed, ref, watch } from 'vue';
import type { JiraIssue } from '@kermanych/cloud';
import type { Session } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api } from '../../lib/api';
import { launchDefaults, type JiraTransitionView, type LaunchDefaults } from '../../lib/jira-view';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';

const props = defineProps<{ modelValue: boolean; issue: JiraIssue; workspaceId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launched: [session: Session, transitionError?: string];
}>();

const cloud = useProjects();
const local = useOrchestrator();

const projectPick = ref('');
const transitionPick = ref('');
const transitions = ref<JiraTransitionView[]>([]);
const defaults = ref<LaunchDefaults>({ askStatus: false });
const busy = ref(false);
const error = ref('');

const workspaceProjects = computed(() => cloud.projects.filter((p) => p.workspaceId === props.workspaceId));

const projectOptions = computed<KSelectOption[]>(() =>
  workspaceProjects.value.map((p) => ({ value: p.id, label: p.name })),
);

const transitionOptions = computed<KSelectOption[]>(() =>
  transitions.value.map((t) => ({ value: t.id, label: t.to.name })),
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
      transitions.value = await api.jiraTransitions(props.workspaceId, props.issue.key);
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
    const res = await api.jiraLaunch(
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
.jld {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.jld__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.jld__note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.jld__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
