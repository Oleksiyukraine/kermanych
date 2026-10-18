<template>
  <KModal
    :model-value="modelValue"
    :title="routine ? t('management.routines.editor.editTitle') : t('management.routines.editor.newTitle')"
    width="640px"
    :persistent="saving"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="rtn-ed">
      <KField v-model="form.name" :label="t('management.routines.editor.name')" :placeholder="t('management.routines.editor.namePlaceholder')" />

      <!-- Scope first: it decides what a prompt does and which projects a note may cover. Fixed
           once saved, like a card's project — a routine moved between scopes is a different
           routine. -->
      <div class="rtn-ed__pair">
        <KSelect
          :model-value="form.scope || WORKSPACE_SCOPE"
          :label="t('management.routines.editor.scope')"
          :options="scopeOptions"
          :disabled="!!routine"
          @update:model-value="pickScope"
        />
        <KSelect
          :model-value="form.kind"
          :label="t('management.routines.editor.kind')"
          :options="kindOptions"
          @update:model-value="(v: string) => (form.kind = v as RoutineActionKind)"
        />
      </div>

      <!-- Where it runs: the author's computer (their checkouts, Slack account and plan, only
           while Kermanych is open) or the workspace's cloud runner (always, with the
           workspace's own keys). -->
      <KSelect
        :model-value="form.runner"
        :label="t('management.routines.editor.runner')"
        :options="runnerOptions"
        @update:model-value="(v: string) => (form.runner = v as RoutineRunner)"
      />
      <p v-if="form.runner === 'cloud' && cloudMissing" class="rtn-ed__hint rtn-ed__hint--warn">
        {{ cloudStatus === null ? t('management.routines.editor.cloudUnavailable') : t('management.routines.editor.cloudNotReady') }}
      </p>

      <!-- ── What it does ───────────────────────────────────────────────────── -->
      <template v-if="form.kind === 'prompt'">
        <KField
          v-model="form.prompt"
          :label="t('management.routines.editor.prompt')"
          :placeholder="t('management.routines.editor.promptPlaceholder')"
          multiline
          :rows="7"
        />
        <p class="rtn-ed__hint">
          <template v-if="form.scope">
            {{ form.runner === 'cloud' ? t('management.routines.editor.promptProjectCloudHint', { project: scopeName }) : t('management.routines.editor.promptProjectHint', { project: scopeName }) }}
          </template>
          <template v-else>
            {{ form.runner === 'cloud' ? t('management.routines.editor.promptWorkspaceCloudHint') : t('management.routines.editor.promptWorkspaceHint') }}
          </template>
        </p>
        <KCheckbox v-if="form.scope" v-model="form.hideFromBoard" :label="t('management.routines.editor.hideFromBoard')" />
      </template>

      <template v-else>
        <KSelect
          v-if="!form.scope"
          multiple
          :values="form.projectIds"
          :label="t('management.routines.editor.projects')"
          :options="projectOptions"
          :summary="projectSummary"
          @update:values="pickProjects"
        />
        <div v-if="sourceProjects.length" class="rtn-ed__pair">
          <KSelect
            v-for="p in sourceProjects"
            :key="p.id"
            :model-value="form.branches[p.id] ?? ''"
            :label="t('management.releases.branchFor', { project: p.name })"
            :options="branchOptions(p.id)"
            :placeholder="branchLists[p.id]?.failed ? t('management.releases.branchPlaceholderFailed') : t('management.releases.branchPlaceholderEmpty')"
            :disabled="!branchOptions(p.id).length"
            searchable
            @update:model-value="(v: string) => (form.branches[p.id] = v)"
          />
        </div>
        <div class="rtn-ed__pair">
          <KField v-model="form.periodDays" type="number" :label="t('management.routines.editor.periodDays')" />
        </div>
        <KCheckbox v-model="form.byPerson" :label="t('management.releases.byPersonLabel')" />
        <p class="rtn-ed__hint">{{ t('management.routines.editor.releaseHint') }}</p>
      </template>

      <!-- ── When ───────────────────────────────────────────────────────────── -->
      <div class="rtn-ed__pair">
        <KSelect
          :model-value="form.frequency"
          :label="t('management.routines.editor.frequency')"
          :options="frequencyOptions"
          @update:model-value="(v: string) => (form.frequency = v as RoutineScheduleKind)"
        />
        <KField
          v-if="form.frequency === 'hourly'"
          v-model="form.minute"
          type="number"
          :label="t('management.routines.editor.minute')"
        />
        <KField
          v-else-if="form.frequency !== 'manual'"
          v-model="form.time"
          type="time"
          :label="t('management.routines.editor.time')"
        />
      </div>
      <KDateField v-if="form.frequency === 'once'" v-model="form.date" :label="t('management.routines.editor.date')" />
      <div v-if="form.frequency === 'weekly'" class="rtn-ed__days" role="group" :aria-label="t('management.routines.editor.days')">
        <KCheckbox
          v-for="d in WEEK_ORDER"
          :key="d"
          :model-value="form.days.includes(d)"
          :label="t(`management.routines.weekday.${d}`)"
          @update:model-value="(on: boolean) => toggleDay(d, on)"
        />
      </div>
      <KField
        v-if="form.frequency === 'monthly'"
        v-model="form.day"
        type="number"
        :label="t('management.routines.editor.dayOfMonth')"
      />
      <p class="rtn-ed__hint">
        {{ t('management.routines.editor.zoneHint', { zone: timezone }) }}
        <template v-if="nextRun"> {{ t('management.routines.editor.nextRun', { when: nextRun }) }}</template>
      </p>

      <!-- ── Where the result goes ──────────────────────────────────────────── -->
      <template v-if="slackAllowed">
        <KCheckbox v-model="form.slackOn" :label="t('management.routines.editor.slack')" />
        <template v-if="form.slackOn && form.runner === 'cloud'">
          <p v-if="!cloudStatus?.slack" class="rtn-ed__hint">{{ t('management.routines.editor.slackNoBot') }}</p>
          <KSelect
            v-else
            :model-value="form.channelId"
            :label="t('management.routines.editor.slackBotChannel', { team: cloudStatus.slack.teamName })"
            :options="channelOptions"
            :placeholder="channelsError ? t('management.routines.editor.slackChannelsFailed') : t('management.routines.editor.slackChannelPlaceholder')"
            searchable
            @update:model-value="(v: string) => (form.channelId = v)"
          />
          <p v-if="cloudStatus?.slack" class="rtn-ed__hint">{{ t('management.routines.editor.slackBotHint') }}</p>
        </template>
        <template v-else-if="form.slackOn">
          <p v-if="!slackAccount?.connected && !slack.settings[workspaceId]" class="rtn-ed__hint">
            {{ t('management.routines.editor.slackNoApp') }}
          </p>
          <div v-else-if="!slackAccount?.connected" class="rtn-ed__row">
            <span class="rtn-ed__hint">{{ slack.canConnect ? t('management.routines.editor.slackConnectHint') : t('releaseSlack.desktopOnly') }}</span>
            <KBtn v-if="slack.canConnect" variant="secondary" :loading="connecting" @click="connectSlack">
              {{ t('management.routines.editor.slackConnect') }}
            </KBtn>
          </div>
          <KSelect
            v-else
            :model-value="form.channelId"
            :label="t('management.routines.editor.slackChannel', { team: slackAccount.teamName })"
            :options="channelOptions"
            :placeholder="channelsError ? t('management.routines.editor.slackChannelsFailed') : t('management.routines.editor.slackChannelPlaceholder')"
            searchable
            @update:model-value="(v: string) => (form.channelId = v)"
          />
          <p v-if="slackAccount" class="rtn-ed__hint">{{ t('management.routines.editor.slackHint') }}</p>
        </template>
        <p v-if="form.slackOn && channelsError && channelsFor === form.runner" class="rtn-ed__error">{{ channelsError }}</p>
      </template>
      <p v-else-if="form.kind === 'prompt' && form.scope" class="rtn-ed__hint">
        {{ t('management.routines.editor.slackAgentHint') }}
      </p>

      <p class="rtn-ed__hint rtn-ed__hint--runner">
        {{ form.runner === 'cloud' ? t('management.routines.editor.runnerCloudHint') : t('management.routines.editor.runnerHint') }}
      </p>
      <p v-if="error" class="rtn-ed__error">{{ error }}</p>
    </div>

    <template #controls>
      <KBtn variant="ghost" :disabled="saving" @click="emit('update:modelValue', false)">{{ t('management.routines.cancel') }}</KBtn>
      <KBtn variant="primary" :loading="saving" @click="save">{{ t('management.routines.editor.save') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The routine form: what a routine does, where it runs, when, and where its result goes. It
// validates with core's `validateRoutine` — the same vocabulary both runners run — and writes
// the row through the routines store under the operator's own JWT.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  nextOccurrence,
  parseRoutineSchedule,
  validateRoutine,
  type RoutineActionKind,
  type RoutineRunner,
  type RoutineDraft,
  type RoutineSchedule,
  type RoutineScheduleKind,
} from '@kermanych/core';
import type { WorkspaceRoutine } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KField from 'components/kit/KField.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KDateField from 'components/kit/KDateField.vue';
import KBtn from 'components/kit/KBtn.vue';
import { useRoutines } from 'stores/routines';
import { useReleaseSlack } from 'stores/release-slack';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import type { SlackChannelOption } from '../../lib/api';
import { formatInstant, WEEK_ORDER } from '../../lib/routines';

const props = defineProps<{
  modelValue: boolean;
  workspaceId: string;
  // The routine being edited; absent for a new one.
  routine?: WorkspaceRoutine | undefined;
  // The scope a new routine starts in — the project the sidebar has selected, if any.
  defaultProjectId?: string | undefined;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [routine: WorkspaceRoutine] }>();

const { t, te, locale } = useI18n();
const store = useRoutines();
const slack = useReleaseSlack();
const projects = useProjects();
const local = useOrchestrator();

const form = reactive({
  name: '',
  scope: '',
  kind: 'release_notes' as RoutineActionKind,
  prompt: '',
  hideFromBoard: false,
  projectIds: [] as string[],
  branches: {} as Record<string, string>,
  periodDays: '7',
  byPerson: false,
  frequency: 'weekly' as RoutineScheduleKind,
  date: '',
  time: '10:00',
  minute: '0',
  days: [1] as number[],
  day: '1',
  slackOn: false,
  channelId: '',
  runner: 'local' as RoutineRunner,
});
const saving = ref(false);
const error = ref('');
// A new routine reads its times on this browser's clock; an existing one keeps the zone it was
// written in, so editing its name from another country does not move its time.
const timezone = computed(() => props.routine?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

const workspaceProjects = computed(() => projects.projects.filter((p) => p.workspaceId === props.workspaceId));

// ── where it runs ─────────────────────────────────────────────────────────────

// `null` = the cloud runner could not be asked (not deployed, offline); undefined = not loaded.
const cloudStatus = computed(() => store.cloud[props.workspaceId]);
const runnerOptions = computed<KSelectOption[]>(() => [
  { value: 'local', label: t('management.routines.runner.local') },
  { value: 'cloud', label: t('management.routines.runner.cloud') },
]);
// A project prompt in the cloud only files its card, which needs no key; everything else reads
// GitHub and asks the model.
const cloudMissing = computed(() => !(form.kind === 'prompt' && form.scope) && !cloudStatus.value?.configured);

// The scope picker's value for «the whole workspace». `form.scope` itself stays '' for it —
// what the row stores as a null project — so every check below reads as «has a project».
const WORKSPACE_SCOPE = 'workspace';
const scopeOptions = computed<KSelectOption[]>(() => [
  { value: WORKSPACE_SCOPE, label: t('management.routines.scopeWorkspace') },
  ...workspaceProjects.value.map((p) => ({ value: p.id, label: p.name })),
]);
const scopeName = computed(() => workspaceProjects.value.find((p) => p.id === form.scope)?.name ?? '');

const kindOptions = computed<KSelectOption[]>(() => [
  { value: 'release_notes', label: t('management.routines.kind.release_notes') },
  { value: 'prompt', label: form.scope ? t('management.routines.kind.promptProject') : t('management.routines.kind.promptWorkspace') },
]);

const frequencyOptions = computed<KSelectOption[]>(() =>
  (['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'manual'] as const).map((k) => ({
    value: k,
    label: t(`management.routines.frequency.${k}`),
  })),
);

const projectOptions = computed<KSelectOption[]>(() =>
  workspaceProjects.value.map((p) => ({
    value: p.id,
    label: local.projects.find((lp) => lp.id === p.id)?.localRepoPath
      ? p.name
      : t('management.releases.projectUnbound', { name: p.name }),
  })),
);
const projectSummary = computed(() =>
  sourceProjects.value.length ? sourceProjects.value.map((p) => p.name).join(', ') : t('management.releases.projectPlaceholder'),
);

// The projects a note reads: the routine's own project, or the ones picked for a workspace note.
const sourceIds = computed(() => (form.scope ? [form.scope] : form.projectIds));
const sourceProjects = computed(() => sourceIds.value.flatMap((id) => workspaceProjects.value.find((p) => p.id === id) ?? []));

// ── branches ──────────────────────────────────────────────────────────────────

const branchLists = ref<Record<string, { branches: string[]; failed: boolean }>>({});

async function loadBranches(projectId: string): Promise<void> {
  try {
    const info = await local.listBranches(projectId);
    branchLists.value = { ...branchLists.value, [projectId]: { branches: info.branches, failed: false } };
    // A saved routine keeps its branch even when this clone lacks it: the routine runs on its
    // author's machine, whose clone is the one that counts. A new pick starts on the default.
    if (!form.branches[projectId]) form.branches[projectId] = info.default ?? info.current ?? info.branches[0] ?? '';
  } catch {
    branchLists.value = { ...branchLists.value, [projectId]: { branches: [], failed: true } };
  }
}

// The clone's branches, plus the branch a saved routine names when this machine's clone lacks
// it (not bound here, or not fetched yet) — an edit of the name must not drop the branch — and
// the project's default branch, so a cloud routine can be set up for a project nobody bound on
// this machine: the cloud reads GitHub, not a clone.
function branchOptions(projectId: string): string[] {
  const listed = branchLists.value[projectId]?.branches ?? [];
  const extra = [form.branches[projectId], workspaceProjects.value.find((p) => p.id === projectId)?.defaultBranch];
  return [...new Set([...extra.filter((b): b is string => !!b), ...listed])];
}

function pickProjects(ids: string[]): void {
  const added = ids.filter((id) => !form.projectIds.includes(id));
  form.projectIds = ids;
  for (const id of added) void loadBranches(id);
}

function pickScope(value: string): void {
  form.scope = value === WORKSPACE_SCOPE ? '' : value;
  if (form.scope && !branchLists.value[form.scope]) void loadBranches(form.scope);
}

function toggleDay(day: number, on: boolean): void {
  form.days = on ? [...new Set([...form.days, day])] : form.days.filter((d) => d !== day);
}

// ── Slack ─────────────────────────────────────────────────────────────────────

// An agent session has no document to post — its result is the session in «Агенти».
const slackAllowed = computed(() => !(form.kind === 'prompt' && form.scope));
const slackAccount = computed(() => {
  const a = slack.accounts[props.workspaceId];
  return a?.connected ? a : undefined;
});
// The channels of whoever posts: the author's own Slack account for a local routine, the
// workspace's bot for a cloud one.
const channels = ref<SlackChannelOption[]>([]);
const channelsFor = ref<RoutineRunner | undefined>(undefined);
// Why the channels could not be read — shown, since «could not read» alone leaves nothing to do.
const channelsError = ref('');
const connecting = ref(false);
const channelOptions = computed<KSelectOption[]>(() => channels.value.map((c) => ({ value: c.id, label: `#${c.name}` })));

async function loadChannels(): Promise<void> {
  const runner = form.runner;
  channelsError.value = '';
  channelsFor.value = runner;
  try {
    const list = runner === 'cloud' ? await store.cloudChannels(props.workspaceId) : await slack.channels(props.workspaceId);
    if (form.runner !== runner) return;
    channels.value = list;
    if (!list.some((c) => c.id === form.channelId)) form.channelId = slack.settings[props.workspaceId]?.channelId ?? '';
  } catch (e) {
    if (form.runner !== runner) return;
    channels.value = [];
    channelsError.value = e instanceof Error ? e.message : String(e);
  }
}

async function connectSlack(): Promise<void> {
  connecting.value = true;
  try {
    await slack.connect(props.workspaceId);
    await loadChannels();
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    connecting.value = false;
  }
}

watch(
  () => [form.slackOn, form.runner, !!slackAccount.value, !!cloudStatus.value?.slack] as const,
  ([on, runner, account, bot]) => {
    if (!on || !(runner === 'cloud' ? bot : account)) return;
    if (channelsFor.value !== runner || !channels.value.length) void loadChannels();
  },
);

// ── the draft ─────────────────────────────────────────────────────────────────

function schedule(): RoutineSchedule {
  switch (form.frequency) {
    case 'manual':
      return { kind: 'manual' };
    case 'once':
      return { kind: 'once', date: form.date, time: form.time };
    case 'hourly':
      return { kind: 'hourly', minute: Number(form.minute) };
    case 'daily':
    case 'weekdays':
      return { kind: form.frequency, time: form.time };
    case 'weekly':
      return { kind: 'weekly', days: form.days, time: form.time };
    case 'monthly':
      return { kind: 'monthly', day: Number(form.day), time: form.time };
  }
}

const draft = computed<RoutineDraft>(() => {
  const channel = channels.value.find((c) => c.id === form.channelId);
  // A saved channel counts as long as the routine still posts through the same identity.
  const keptSlack =
    props.routine?.slack?.channelId === form.channelId && props.routine.runner === form.runner ? props.routine.slack : undefined;
  const poster = form.runner === 'cloud' ? cloudStatus.value?.slack?.teamId : slackAccount.value?.teamId;
  const target =
    channel && poster && channelsFor.value === form.runner
      ? { teamId: poster, channelId: channel.id, channelName: channel.name }
      : keptSlack;
  return {
    name: form.name,
    ...(form.scope ? { projectId: form.scope } : {}),
    runner: form.runner,
    timezone: timezone.value,
    action:
      form.kind === 'prompt'
        ? { kind: 'prompt', prompt: form.prompt, hideFromBoard: form.hideFromBoard }
        : {
            kind: 'release_notes',
            sources: sourceIds.value.map((id) => ({ projectId: id, branch: form.branches[id] ?? '' })),
            periodDays: Number(form.periodDays),
            groupBy: form.byPerson ? 'person' : 'topic',
          },
    schedule: schedule(),
    // On without a channel is sent as an empty target, so the validator names it.
    ...(slackAllowed.value && form.slackOn ? { slack: target ?? {} } : {}),
  };
});

// Read off the schedule alone, so the preview answers while the rest of the form is still empty.
const nextRun = computed(() => {
  const parsed = parseRoutineSchedule(schedule());
  if ('error' in parsed) return '';
  const at = nextOccurrence(parsed.schedule, timezone.value, Date.now());
  return at === undefined ? '' : formatInstant(at, timezone.value, locale.value);
});

// ── open / save ───────────────────────────────────────────────────────────────

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    error.value = '';
    void slack.load(props.workspaceId);
    void store.loadCloud(props.workspaceId);
    channels.value = [];
    channelsFor.value = undefined;
    const r = props.routine;
    const s = r?.schedule;
    const a = r?.action;
    Object.assign(form, {
      name: r?.name ?? '',
      scope: r ? (r.projectId ?? '') : (props.defaultProjectId ?? ''),
      kind: a?.kind ?? 'release_notes',
      prompt: a?.kind === 'prompt' ? a.prompt : '',
      hideFromBoard: a?.kind === 'prompt' ? a.hideFromBoard === true : false,
      projectIds: a?.kind === 'release_notes' && !r?.projectId ? a.sources.map((x) => x.projectId) : [],
      branches: a?.kind === 'release_notes' ? Object.fromEntries(a.sources.map((x) => [x.projectId, x.branch])) : {},
      periodDays: a?.kind === 'release_notes' ? String(a.periodDays) : '7',
      byPerson: a?.kind === 'release_notes' ? a.groupBy === 'person' : false,
      frequency: s?.kind ?? 'weekly',
      date: s?.kind === 'once' ? s.date : '',
      time: s && 'time' in s ? s.time : '10:00',
      minute: s?.kind === 'hourly' ? String(s.minute) : '0',
      days: s?.kind === 'weekly' ? [...s.days] : [1],
      day: s?.kind === 'monthly' ? String(s.day) : '1',
      slackOn: !!r?.slack,
      channelId: r?.slack?.channelId ?? '',
      // A new routine starts in the cloud when the workspace has one: that is the runner that
      // does not depend on anybody's computer being on.
      runner: r?.runner ?? (store.cloud[props.workspaceId]?.configured ? 'cloud' : 'local'),
    });
    for (const id of sourceIds.value) void loadBranches(id);
  },
  { immediate: true },
);

async function save(): Promise<void> {
  error.value = '';
  const checked = validateRoutine(draft.value);
  if ('error' in checked) {
    const key = `management.routines.invalid.${checked.code}`;
    error.value = te(key) ? t(key) : checked.error;
    return;
  }
  const v = checked.routine;
  if (v.schedule.kind === 'once' && nextOccurrence(v.schedule, v.timezone, Date.now()) === undefined) {
    error.value = t('management.routines.editor.oncePast');
    return;
  }
  if (v.runner === 'cloud' && cloudMissing.value) {
    error.value = t('management.routines.editor.cloudNotReady');
    return;
  }
  saving.value = true;
  try {
    const saved = props.routine
      ? await store.update(props.routine, {
          name: v.name,
          runner: v.runner,
          action: v.action,
          schedule: v.schedule,
          timezone: v.timezone,
          slack: v.slack ?? null,
        })
      : await store.create({ workspaceId: props.workspaceId, ...v });
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.rtn-ed {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rtn-ed__pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-3);
  align-items: end;
}

.rtn-ed__days {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-3);
}

.rtn-ed__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
}

.rtn-ed__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-faint);
}

.rtn-ed__hint--runner {
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.rtn-ed__hint--warn {
  color: var(--k-warn, var(--k-danger));
}

.rtn-ed__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}
</style>
