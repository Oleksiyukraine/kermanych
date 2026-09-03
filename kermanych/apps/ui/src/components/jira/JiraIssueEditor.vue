<template>
  <KModal :model-value="modelValue" :title="title" width="560px" @update:model-value="emit('update:modelValue', $event)">
    <div class="jie">
      <KField v-model="summary" :label="t('jira.issueEditor.summaryLabel')" :placeholder="t('jira.issueEditor.summaryPlaceholder')" />
      <KField v-model="description" :label="t('jira.issueEditor.descLabel')" multiline :rows="5" :placeholder="t('jira.issueEditor.descPlaceholder')" />
      <div class="jie__row">
        <KSelect v-model="typePick" :label="t('jira.issueEditor.typeLabel')" :options="typeOptions" placeholder="—" :disabled="!!editKey" />
        <KSelect v-model="priorityPick" :label="t('jira.issueEditor.priorityLabel')" :options="priorityOptions" placeholder="—" />
      </div>
      <KSelect
        v-model="assigneePick"
        :label="t('jira.issueEditor.assigneeLabel')"
        :options="assigneeOptions"
        :placeholder="t('jira.issueEditor.assigneePlaceholder')"
        searchable
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
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ t('jira.issueEditor.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="!summary.trim() || busy" @click="save">
        {{ busy ? t('jira.issueEditor.saving') : editKey ? t('jira.issueEditor.save') : t('jira.issueEditor.create') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Create/edit a Jira ticket with the STANDARD fields only (the agreed v1 line): summary,
// plain-text description, type, priority, assignee (from Jira's own assignable list),
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
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api, type JiraAssignableUser, type JiraEditorOptions, type JiraIssueDraftWire } from '../../lib/api';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue: boolean;
  workspaceId: string;
  // Present = edit this issue; absent = create a new one.
  issue?: JiraIssue | undefined;
  // Create-only: make the new issue a subtask of this parent.
  parentKey?: string | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [issue: JiraIssue] }>();

const summary = ref('');
const description = ref('');
const typePick = ref('');
const priorityPick = ref('');
const assigneePick = ref('');
const labelsInput = ref('');
const startDate = ref('');
const dueDate = ref('');
const busy = ref(false);
const error = ref('');

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
    error.value = '';
    const issue = props.issue;
    summary.value = issue?.summary ?? '';
    // Edit starts from PLAIN TEXT: the mirror holds rendered HTML, and round-tripping it
    // through an ADF paragraph would double-encode markup. Stripping tags is the honest
    // degradation for a v1 whose composer is plain text anyway.
    description.value = issue ? htmlToText(issue.descriptionHtml) : '';
    priorityPick.value = '';
    typePick.value = '';
    assigneePick.value = issue?.assigneeAccountId ?? '';
    labelsInput.value = issue?.labels.join(', ') ?? '';
    startDate.value = issue?.startDate ?? '';
    dueDate.value = issue?.dueDate ?? '';
    try {
      const [opts, users] = await Promise.all([
        api.jiraEditorOptions(props.workspaceId),
        api.jiraAssignableUsers(props.workspaceId, ''),
      ]);
      options.value = opts;
      assignable.value = users;
      if (issue) {
        priorityPick.value = opts.priorities.find((p) => p.name === issue.priorityName)?.id ?? '';
      } else {
        typePick.value = typeOptions.value[0]?.value ?? '';
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  },
);

function htmlToText(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.textContent?.trim() ?? '';
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  const labels = labelsInput.value
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  try {
    // On CREATE a date left blank is simply not sent: a project whose create screen has no
    // due date refuses `duedate: null`, and «не заповнив» was never «очисти».
    // On EDIT a cleared input IS the instruction to clear the date in Jira.
    const dates: JiraIssueDraftWire = {};
    if (props.issue || dueDate.value) dates.dueDate = dueDate.value;
    if (options.value.startDateSupported && (props.issue || startDate.value))
      dates.startDate = startDate.value;
    const draft: JiraIssueDraftWire = {
      summary: summary.value,
      description: description.value,
      ...(typePick.value ? { issueTypeId: typePick.value } : {}),
      ...(priorityPick.value ? { priorityId: priorityPick.value } : {}),
      labels,
      assigneeAccountId: assigneePick.value || null,
      ...dates,
      ...(props.parentKey ? { parentKey: props.parentKey } : {}),
    };
    const saved = props.issue
      ? await api.jiraEditIssue(props.workspaceId, props.issue.key, draft)
      : await api.jiraCreateIssue(props.workspaceId, draft);
    emit('update:modelValue', false);
    emit('saved', saved);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
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
