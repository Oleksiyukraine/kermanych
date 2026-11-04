<template>
  <KModal :model-value="modelValue" :title="title" width="560px" :persistent="busy" @update:model-value="onToggle">
    <div class="pie">
      <KField v-model="summary" :label="t('plane.issueEditor.summaryLabel')" :placeholder="t('plane.issueEditor.summaryPlaceholder')" />
      <!-- Until the item's markdown arrives the body is a placeholder, not an empty field:
           text typed into it would be overwritten by the load, or saved over Plane's body. -->
      <KSkeleton v-if="phase === 'skeleton'" variant="block" height="118px" />
      <div v-else>
        <KField
          ref="descriptionField"
          v-model="description"
          :label="t('plane.issueEditor.descLabel')"
          multiline
          :rows="5"
          :placeholder="t('plane.issueEditor.descPlaceholder')"
          :disabled="!loaded"
          @keydown="dictation.onKeydown"
        />
        <!-- Диктування (docs/specs/2026-11-03-voice-dictation.md). -->
        <KDictation
          class="pie__dictate"
          :state="dictation.state.value"
          :caption="dictation.caption.value"
          :level="dictation.level.value"
          :disabled="!loaded"
          @toggle="dictation.toggle"
        />
      </div>
      <div class="pie__row">
        <!-- Work-item types exist only where the project has them (Plane Pro): no field
             otherwise, rather than a select with nothing in it. -->
        <KSelect
          v-if="typeOptions.length"
          v-model="typePick"
          :label="t('plane.issueEditor.typeLabel')"
          :options="typeOptions"
          placeholder="—"
          :disabled="!!editKey"
          :loading="loading"
        />
        <KSelect v-model="priorityPick" :label="t('plane.issueEditor.priorityLabel')" :options="priorityOptions" />
      </div>
      <KSelect
        v-model="assigneePick"
        :label="t('plane.issueEditor.assigneeLabel')"
        :options="assigneeOptions"
        :placeholder="t('plane.issueEditor.assigneePlaceholder')"
        searchable
        :loading="loading"
      />
      <KSelect
        :label="t('plane.issueEditor.labelsLabel')"
        :options="labelOptions"
        multiple
        searchable
        :values="labelsPick"
        :summary="labelsSummary"
        :placeholder="t('plane.issueEditor.labelsPlaceholder')"
        :loading="loading"
        @update:values="labelsPick = $event"
      />
      <div class="pie__row">
        <KField v-model="startDate" :label="t('plane.issueEditor.startLabel')" type="date" />
        <KField v-model="dueDate" :label="t('plane.issueEditor.dueLabel')" type="date" />
      </div>
      <!-- The estimate is a pick from the project's estimate points; a project without an
           estimate system (or an edition without the endpoint) shows no field. -->
      <KSelect
        v-if="estimateOptions.length > 1"
        v-model="estimatePick"
        :label="t('plane.issueEditor.estimateLabel')"
        :options="estimateOptions"
        :loading="loading"
      />
      <p v-if="parentKey" class="pie__note mono">{{ t('plane.issueEditor.subtaskOf', { key: parentKey }) }}</p>
      <KSelect
        v-else
        v-model="parentPick"
        :label="t('plane.issueEditor.parentLabel')"
        :options="parentOptions"
        :placeholder="t('plane.issueEditor.parentNone')"
        searchable
      />
      <p v-if="error" class="pie__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('plane.issueEditor.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="!loaded || !summary.trim()" :loading="busy" @click="save">
        {{ busy ? t('plane.issueEditor.saving') : editKey ? t('plane.issueEditor.save') : t('plane.issueEditor.create') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Create/edit a Plane work item with the standard fields: summary, markdown description
// (the api renders Plane's editor HTML, task lists included), type (where the project has
// types), priority (Plane's fixed five), assignee (ONE person — spec Decision 6), labels (by
// name, from the project's own labels), the estimate point (where the project estimates),
// the start and target dates, and the parent. A sub-work item is a create with `parentKey`.
import { computed, ref, watch } from 'vue';
import type { PlaneIssue } from '@kermanych/cloud';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KDictation from 'components/kit/KDictation.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api, type PlaneAssignableUser, type PlaneEditorOptions, type PlaneIssueDraft } from '../../lib/api';
import { PLANE_PRIORITIES, priorityValue } from '../../lib/plane-view';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useDictationField } from '../../composables/useDictationField';
import { usePlane } from 'stores/plane';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue: boolean;
  integrationId: string;
  // Present = edit this item; absent = create a new one.
  issue?: PlaneIssue | undefined;
  // Create-only: make the new item a sub-work item of this parent.
  parentKey?: string | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [issue: PlaneIssue] }>();

const plane = usePlane();

const summary = ref('');
const description = ref('');
const descriptionField = ref<InstanceType<typeof KField> | null>(null);
// Диктування: the description is said rather than typed; closing the editor drops the phrase.
const dictation = useDictationField({ el: () => descriptionField.value?.el(), value: description });
// The description as it was loaded, so a save that did not touch it leaves Plane's body
// alone: markdown cannot carry everything Plane's editor can (mentions, embedded images),
// and an edit of the priority must not rewrite the text through it.
const loadedDescription = ref('');
const typePick = ref('');
const priorityPick = ref('none');
const assigneePick = ref('');
const labelsPick = ref<string[]>([]);
const estimatePick = ref('');
const parentPick = ref('');
const startDate = ref('');
const dueDate = ref('');
const error = ref('');
// The editor lists and the description have answered for THIS open. Save waits on it: a
// save before it would send a blank description over Plane's body. A failed load keeps Save
// off; the error says why.
const loaded = ref(false);
// The read for this open is still running (false after a failure too).
const loading = ref(false);
let openRun = 0;
const phase = useLoadPhase(() => props.modelValue && loading.value);

// The worklog half is inert here — this editor writes item fields, never time entries —
// but the shape is one contract, so the placeholder states «no identity, no permissions».
const options = ref<PlaneEditorOptions>({
  issueTypes: [],
  priorities: [],
  labels: [],
  states: [],
  estimatePoints: [],
  estimateType: '',
  timeTrackingEnabled: false,
  myAccountId: '',
  worklog: { editOwn: false, editAll: false, deleteOwn: false, deleteAll: false },
});
const assignable = ref<PlaneAssignableUser[]>([]);

const editKey = computed(() => props.issue?.key);
const parentKey = computed(() => props.parentKey);
const { t } = useI18n();
const title = computed(() =>
  props.issue
    ? t('plane.issueEditor.editTitle', { key: props.issue.key })
    : props.parentKey
      ? t('plane.issueEditor.subtaskOf', { key: props.parentKey })
      : t('plane.issueEditor.newTitle'),
);

const typeOptions = computed<KSelectOption[]>(() =>
  options.value.issueTypes.map((ty) => ({ value: ty.id, label: ty.name })),
);

// Plane's fixed enum, labelled from i18n: no read to wait for.
const priorityOptions = computed<KSelectOption[]>(() =>
  PLANE_PRIORITIES.map((p) => ({ value: p, label: t(`plane.priority.${p}`) })),
);

const assigneeOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('plane.issueEditor.assigneePlaceholder') },
  ...assignable.value.map((u) => ({ value: u.accountId, label: u.displayName })),
]);

// The project's labels by name. A label the item already carries but the list lacks (made
// meanwhile in Plane) stays offered, so an edit does not silently drop it.
const labelOptions = computed<KSelectOption[]>(() => {
  const names = options.value.labels.map((l) => l.name);
  for (const held of labelsPick.value) if (!names.includes(held)) names.push(held);
  return names.map((n) => ({ value: n, label: n }));
});
const labelsSummary = computed(() =>
  labelsPick.value.length ? labelsPick.value.join(', ') : t('plane.issueEditor.labelsPlaceholder'),
);

// '' first: «no estimate» is a real choice, and it is how an estimate is cleared.
const estimateOptions = computed<KSelectOption[]>(() =>
  options.value.estimatePoints.length
    ? [
        { value: '', label: t('plane.issueEditor.estimateNone') },
        ...options.value.estimatePoints.map((p) => ({ value: p.id, label: p.value })),
      ]
    : [],
);

// Any item on this board may be the parent, except the item itself — the obvious cycle.
// Deeper cycles are Plane's to refuse; its message lands in the error line.
const parentOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('plane.issueEditor.parentNone') },
  ...plane.issues
    .filter((i) => i.key !== props.issue?.key)
    .map((i) => ({ value: i.key, label: `${i.key} · ${i.summary}` })),
]);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return dictation.cancel();
    const mine = ++openRun;
    error.value = '';
    loaded.value = false;
    loading.value = true;
    const issue = props.issue;
    summary.value = issue?.summary ?? '';
    // Edit starts from MARKDOWN converted from the item's editor HTML by the api (not the
    // mirror's HTML, which a textarea cannot round-trip). Blank until it arrives; a failed
    // load leaves it blank and unsent.
    description.value = '';
    loadedDescription.value = '';
    typePick.value = '';
    priorityPick.value = priorityValue(issue?.priority ?? 'none');
    assigneePick.value = issue?.assigneeAccountId ?? '';
    labelsPick.value = issue ? [...issue.labels] : [];
    estimatePick.value = issue?.estimatePointId ?? '';
    parentPick.value = issue?.parentKey ?? '';
    startDate.value = issue?.startDate ?? '';
    dueDate.value = issue?.dueDate ?? '';
    try {
      const [lists, desc] = await Promise.all([
        plane.editorLists(),
        issue ? api.planeIssueDescription(props.integrationId, issue.key) : Promise.resolve({ markdown: '' }),
      ]);
      if (mine !== openRun) return;
      options.value = lists.options;
      assignable.value = lists.assignable;
      description.value = desc.markdown;
      loadedDescription.value = desc.markdown;
      // The mirror stores the type's NAME; the picker needs its id.
      typePick.value = issue
        ? (lists.options.issueTypes.find((ty) => ty.name === issue.typeName)?.id ?? '')
        : (typeOptions.value[0]?.value ?? '');
      loaded.value = true;
    } catch (e) {
      if (mine !== openRun) return;
      error.value = errorText(e);
    } finally {
      if (mine === openRun) loading.value = false;
    }
  },
);

// Short op: the modal stays open (persistent, Cancel blocked) until Plane answers; a
// refusal is shown inside it.
const { run: save, busy } = useAsyncAction(
  async () => {
    // The phrase being spoken belongs to the description: it lands before the item is read.
    await dictation.beforeSubmit();
    if (!loaded.value || !summary.value.trim()) return;
    error.value = '';
    const issue = props.issue;
    // On CREATE a field left blank is simply not sent — «не заповнив» was never «очисти».
    // On EDIT the form is the item's whole truth: a cleared date, estimate or parent IS the
    // instruction to clear it in Plane.
    const draft: PlaneIssueDraft = {
      summary: summary.value,
      ...(issue && description.value === loadedDescription.value ? {} : { description: description.value }),
      ...(!issue && typePick.value ? { issueTypeId: typePick.value } : {}),
      priority: priorityValue(priorityPick.value),
      labels: labelsPick.value,
      assigneeAccountId: assigneePick.value || null,
      ...(issue || startDate.value ? { startDate: startDate.value } : {}),
      ...(issue || dueDate.value ? { dueDate: dueDate.value } : {}),
    };
    // Only where the project estimates: elsewhere the field is absent, and a `null` would
    // clear a value set in Plane by a means this form cannot show.
    if (estimateOptions.value.length && (issue || estimatePick.value)) draft.estimatePointId = estimatePick.value || null;
    if (props.parentKey) draft.parentKey = props.parentKey;
    else if (issue ? parentPick.value !== (issue.parentKey ?? '') : parentPick.value) draft.parentKey = parentPick.value;
    const saved = issue
      ? await api.planeEditIssue(props.integrationId, issue.key, draft)
      : await api.planeCreateIssue(props.integrationId, draft);
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
.pie {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
.pie__dictate {
  margin-top: 6px;
}

.pie__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--k-sp-3);
}

.pie__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.pie__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
