<template>
  <KModal :model-value="modelValue" :title="title" width="560px" :persistent="busy" @update:model-value="onToggle">
    <div class="jie">
      <KField v-model="summary" :label="t('jira.issueEditor.summaryLabel')" :placeholder="t('jira.issueEditor.summaryPlaceholder')" />
      <!-- Until the ticket's markdown arrives the body is a placeholder, not an empty field:
           text typed into it would be overwritten by the load, or saved over Jira's body. -->
      <KSkeleton v-if="phase === 'skeleton'" variant="block" height="118px" />
      <KField v-else v-model="description" :label="t('jira.issueEditor.descLabel')" multiline :rows="5" :placeholder="t('jira.issueEditor.descPlaceholder')" :disabled="!loaded" />
      <div class="jie__row">
        <KSelect v-model="typePick" :label="t('jira.issueEditor.typeLabel')" :options="typeOptions" placeholder="—" :disabled="!!editKey" :loading="loading" />
        <KSelect v-model="priorityPick" :label="t('jira.issueEditor.priorityLabel')" :options="priorityOptions" placeholder="—" :loading="loading" />
      </div>
      <KSelect
        v-model="assigneePick"
        :label="t('jira.issueEditor.assigneeLabel')"
        :options="assigneeOptions"
        :placeholder="t('jira.issueEditor.assigneePlaceholder')"
        searchable
        :loading="loading"
      />
      <div class="jie__row">
        <!-- The start field exists only where the site does: see startDateSupported. -->
        <KField v-if="options.startDateSupported" v-model="startDate" :label="t('jira.issueEditor.startLabel')" type="date" />
        <KField v-model="dueDate" :label="t('jira.issueEditor.dueLabel')" type="date" />
      </div>
      <KField v-model="labelsInput" :label="t('jira.issueEditor.labelsLabel')" :placeholder="t('jira.issueEditor.labelsPlaceholder')" />
      <p v-if="parentKey" class="jie__note mono">{{ t('jira.issueEditor.subtaskOf', { key: parentKey }) }}</p>
      <p v-if="error" class="jie__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('jira.issueEditor.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="!loaded || !summary.trim()" :loading="busy" @click="save">
        {{ busy ? t('jira.issueEditor.saving') : editKey ? t('jira.issueEditor.save') : t('jira.issueEditor.create') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Create/edit a Jira ticket with the STANDARD fields only (the agreed v1 line): summary,
// markdown description (the api turns it into Jira's own headings, lists and action items),
// type, priority, assignee (from Jira's own assignable list),
// labels, and the two planning dates — Jira's system `duedate` plus the site's «Start
// date» field, the one custom field the mirror carries because Jira's own board shows it.
// Other custom fields are not editable here.
// A subtask is a create with `parentKey`; Jira picks the subtask type itself when the
// chosen type is subtask-capable.
import { computed, ref, watch } from 'vue';
import type { JiraIssue } from '@kermanych/cloud';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api, type JiraAssignableUser, type JiraEditorOptions, type JiraIssueDraftWire } from '../../lib/api';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue: boolean;
  integrationId: string;
  // Present = edit this issue; absent = create a new one.
  issue?: JiraIssue | undefined;
  // Create-only: make the new issue a subtask of this parent.
  parentKey?: string | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [issue: JiraIssue] }>();

const summary = ref('');
const description = ref('');
// The description as it was loaded, so a save that did not touch it leaves Jira's body
// alone: markdown cannot carry everything ADF can (images, mentions, panels), and an edit
// of the priority must not rewrite the text through it.
const loadedDescription = ref('');
const typePick = ref('');
const priorityPick = ref('');
const assigneePick = ref('');
const labelsInput = ref('');
const startDate = ref('');
const dueDate = ref('');
const error = ref('');
// The editor options (types, priorities, assignees) and the description have answered for
// THIS open. Save waits on it: before, a save sent a blank description over Jira's body or
// a create without `issueTypeId`. A failed load keeps Save off; the error says why.
const loaded = ref(false);
// The read for this open is still running (false after a failure too).
const loading = ref(false);
let openRun = 0;
const phase = useLoadPhase(() => props.modelValue && loading.value);

// The worklog half is inert here — this editor writes issue fields, never time entries —
// but the shape is one contract, so the placeholder states «no identity, no permissions».
const options = ref<JiraEditorOptions>({
  issueTypes: [],
  priorities: [],
  startDateSupported: false,
  myAccountId: '',
  worklog: { editOwn: false, editAll: false, deleteOwn: false, deleteAll: false },
});
const assignable = ref<JiraAssignableUser[]>([]);

const editKey = computed(() => props.issue?.key);
const parentKey = computed(() => props.parentKey);
const { t } = useI18n();
const title = computed(() =>
  props.issue
    ? t('jira.issueEditor.editTitle', { key: props.issue.key })
    : props.parentKey
      ? t('jira.issueEditor.subtaskOf', { key: props.parentKey })
      : t('jira.issueEditor.newTitle'),
);

// Subtask types only under a parent; parent-level types only without one — offering the
// wrong family is a guaranteed Jira refusal at save.
const typeOptions = computed<KSelectOption[]>(() =>
  options.value.issueTypes
    .filter((t) => (props.parentKey ? t.subtask : !t.subtask))
    .map((t) => ({ value: t.id, label: t.name })),
);

const priorityOptions = computed<KSelectOption[]>(() =>
  options.value.priorities.map((p) => ({ value: p.id, label: p.name })),
);

const assigneeOptions = computed<KSelectOption[]>(() =>
  assignable.value.map((u) => ({ value: u.accountId, label: u.displayName })),
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    const mine = ++openRun;
    error.value = '';
    loaded.value = false;
    loading.value = true;
    const issue = props.issue;
    summary.value = issue?.summary ?? '';
    // Edit starts from MARKDOWN read out of the ticket's own ADF (not the mirror's rendered
    // HTML, whose text has lost its structure), so a save round-trips headings, lists and
    // action items. Blank until it arrives; a failed load leaves it blank and unsent.
    description.value = '';
    loadedDescription.value = '';
    priorityPick.value = '';
    typePick.value = '';
    assigneePick.value = issue?.assigneeAccountId ?? '';
    labelsInput.value = issue?.labels.join(', ') ?? '';
    startDate.value = issue?.startDate ?? '';
    dueDate.value = issue?.dueDate ?? '';
    try {
      const [opts, users, desc] = await Promise.all([
        api.jiraEditorOptions(props.integrationId),
        api.jiraAssignableUsers(props.integrationId, ''),
        issue ? api.jiraIssueDescription(props.integrationId, issue.key) : Promise.resolve({ markdown: '' }),
      ]);
      if (mine !== openRun) return;
      options.value = opts;
      assignable.value = users;
      description.value = desc.markdown;
      loadedDescription.value = desc.markdown;
      if (issue) {
        priorityPick.value = opts.priorities.find((p) => p.name === issue.priorityName)?.id ?? '';
      } else {
        typePick.value = typeOptions.value[0]?.value ?? '';
      }
      loaded.value = true;
    } catch (e) {
      if (mine !== openRun) return;
      error.value = errorText(e);
    } finally {
      if (mine === openRun) loading.value = false;
    }
  },
);

// Short op: the modal stays open (persistent, Cancel blocked) until Jira answers; a refusal
// is shown inside it.
const { run: save, busy } = useAsyncAction(
  async () => {
    if (!loaded.value || !summary.value.trim()) return;
    error.value = '';
    const labels = labelsInput.value
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    // On CREATE a date left blank is simply not sent: a project whose create screen has no
    // due date refuses `duedate: null`, and «не заповнив» was never «очисти».
    // On EDIT a cleared input IS the instruction to clear the date in Jira.
    const dates: JiraIssueDraftWire = {};
    if (props.issue || dueDate.value) dates.dueDate = dueDate.value;
    if (options.value.startDateSupported && (props.issue || startDate.value))
      dates.startDate = startDate.value;
    const draft: JiraIssueDraftWire = {
      summary: summary.value,
      ...(props.issue && description.value === loadedDescription.value ? {} : { description: description.value }),
      ...(typePick.value ? { issueTypeId: typePick.value } : {}),
      ...(priorityPick.value ? { priorityId: priorityPick.value } : {}),
      labels,
      assigneeAccountId: assigneePick.value || null,
      ...dates,
      ...(props.parentKey ? { parentKey: props.parentKey } : {}),
    };
    const saved = props.issue
      ? await api.jiraEditIssue(props.integrationId, props.issue.key, draft)
      : await api.jiraCreateIssue(props.integrationId, draft);
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
.jie {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.jie__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--k-sp-3);
}

.jie__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.jie__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
