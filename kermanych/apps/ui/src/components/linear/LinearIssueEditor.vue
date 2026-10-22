<template>
  <KModal :model-value="modelValue" :title="title" width="560px" :persistent="busy" @update:model-value="onToggle">
    <div class="lie">
      <KField v-model="titleField" :label="t('linear.issueEditor.summaryLabel')" :placeholder="t('linear.issueEditor.summaryPlaceholder')" />
      <KField v-model="description" :label="t('linear.issueEditor.descLabel')" multiline :rows="5" :placeholder="t('linear.issueEditor.descPlaceholder')" />
      <div class="lie__row">
        <KSelect v-model="priorityPick" :label="t('linear.issueEditor.priorityLabel')" :options="priorityOptions" />
        <KField v-model="estimateInput" :label="t('linear.issueEditor.estimateLabel')" type="number" :placeholder="t('linear.issueEditor.estimatePlaceholder')" />
      </div>
      <KSelect
        v-model="assigneePick"
        :label="t('linear.issueEditor.assigneeLabel')"
        :options="assigneeOptions"
        :placeholder="t('linear.issueEditor.assigneePlaceholder')"
        searchable
        :loading="loading"
      />
      <div class="lie__row">
        <KField v-model="dueDate" :label="t('linear.issueEditor.dueLabel')" type="date" />
      </div>
      <KField v-model="labelsInput" :label="t('linear.issueEditor.labelsLabel')" :placeholder="t('linear.issueEditor.labelsPlaceholder')" />
      <p v-if="parentKey" class="lie__note mono">{{ t('linear.issueEditor.subtaskOf', { key: parentKey }) }}</p>
      <p v-if="error" class="lie__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('linear.issueEditor.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="loading || !titleField.trim()" :loading="busy" @click="save">
        {{ busy ? t('linear.issueEditor.saving') : editKey ? t('linear.issueEditor.save') : t('linear.issueEditor.create') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Create/edit a Linear ticket with the standard fields (the agreed v1 line): title,
// markdown description, priority (Linear's fixed 0–4 scale), assignee (from Linear's own
// assignable list), labels (by name), estimate in points, and the due date. Linear has no
// issue type and no user-editable start date, so neither appears here.
// A subtask is a create with `parentKey`.
import { computed, ref, watch } from 'vue';
import type { LinearIssue } from '@kermanych/cloud';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api, type LinearAssignableUser, type LinearIssueDraftWire } from '../../lib/api';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue: boolean;
  workspaceId: string;
  // Present = edit this issue; absent = create a new one.
  issue?: LinearIssue | undefined;
  // Create-only: make the new issue a subtask of this parent.
  parentKey?: string | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [issue: LinearIssue] }>();

const titleField = ref('');
const description = ref('');
const priorityPick = ref('0');
const assigneePick = ref('');
const labelsInput = ref('');
const estimateInput = ref('');
const dueDate = ref('');
const error = ref('');
// The assignee list for THIS open is still being read: the picker spins and Save waits, so
// a save cannot race the list (Linear's description comes from the mirror, so nothing else
// is outstanding). A failed read releases Save — the assignee from the mirror stays valid.
const loading = ref(false);
let openRun = 0;

const assignable = ref<LinearAssignableUser[]>([]);

const editKey = computed(() => props.issue?.key);
const parentKey = computed(() => props.parentKey);
const { t } = useI18n();
const title = computed(() =>
  props.issue
    ? t('linear.issueEditor.editTitle', { key: props.issue.key })
    : props.parentKey
      ? t('linear.issueEditor.subtaskOf', { key: props.parentKey })
      : t('linear.issueEditor.newTitle'),
);

// Linear's fixed priority scale, rendered from i18n. The value is the Linear number
// (0 None … 4 Low) as a string for the select, converted back on save.
const priorityOptions = computed<KSelectOption[]>(() => [
  { value: '0', label: t('linear.priority.0') },
  { value: '1', label: t('linear.priority.1') },
  { value: '2', label: t('linear.priority.2') },
  { value: '3', label: t('linear.priority.3') },
  { value: '4', label: t('linear.priority.4') },
]);

const assigneeOptions = computed<KSelectOption[]>(() =>
  assignable.value.map((u) => ({ value: u.id, label: u.name })),
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    const mine = ++openRun;
    error.value = '';
    loading.value = true;
    const issue = props.issue;
    titleField.value = issue?.title ?? '';
    // The mirror already holds markdown, so an edit starts from it verbatim — no lossy
    // HTML round-trip like Jira needs.
    description.value = issue?.descriptionMd ?? '';
    priorityPick.value = String(issue?.priority ?? 0);
    assigneePick.value = issue?.assigneeId ?? '';
    labelsInput.value = issue?.labels.join(', ') ?? '';
    estimateInput.value = issue && issue.estimate > 0 ? String(issue.estimate) : '';
    dueDate.value = issue?.dueDate ?? '';
    try {
      const users = await api.linearAssignableUsers(props.workspaceId, '');
      if (mine === openRun) assignable.value = users;
    } catch (e) {
      if (mine === openRun) error.value = errorText(e);
    } finally {
      if (mine === openRun) loading.value = false;
    }
  },
);

// Short op: the modal stays open (persistent, Cancel blocked) until Linear answers; a
// refusal is shown inside it.
const { run: save, busy } = useAsyncAction(
  async () => {
    if (loading.value || !titleField.value.trim()) return;
    error.value = '';
    const labels = labelsInput.value
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    // A blank estimate clears the points (null); a number sets them.
    const estimateRaw = estimateInput.value.trim();
    const estimate = estimateRaw === '' ? null : Number(estimateRaw);
    // On CREATE a due date left blank is simply not sent; on EDIT a cleared input IS the
    // instruction to clear the date in Linear.
    const draft: LinearIssueDraftWire = {
      title: titleField.value,
      description: description.value,
      priority: Number(priorityPick.value),
      labels,
      assigneeId: assigneePick.value || null,
      estimate,
      ...(props.issue || dueDate.value ? { dueDate: dueDate.value } : {}),
      ...(props.parentKey ? { parentKey: props.parentKey } : {}),
    };
    const saved = props.issue
      ? await api.linearEditIssue(props.workspaceId, props.issue.key, draft)
      : await api.linearCreateIssue(props.workspaceId, draft);
    emit('update:modelValue', false);
    emit('saved', saved);
  },
  { onError: (e) => (error.value = errorText(e)) },
);

function onToggle(open: boolean): void {
  if (!open && busy.value) return;
  emit('update:modelValue', open);
}
</script>

<style scoped lang="scss">
.lie {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.lie__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--k-sp-3);
}

.lie__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.lie__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
