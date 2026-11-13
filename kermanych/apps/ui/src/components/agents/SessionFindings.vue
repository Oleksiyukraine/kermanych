<template>
  <div class="findings">
    <p v-if="loadError" class="findings__error" role="alert">{{ loadError }}</p>
    <!-- Not loaded for this session yet ≠ no findings: rows of skeleton, never «немає». -->
    <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="3" />
    <ul v-else-if="findings.length" class="findings__list">
      <li
        v-for="f in findings"
        :key="f.id"
        class="findings__item"
        :class="{ 'findings__item--dismissed': f.status === 'dismissed' }"
      >
        <div class="findings__head">
          <span class="findings__title">{{ f.title }}</span>
          <KTag class="findings__kind">{{ t(`agents.findings.kind.${f.kind}`) }}</KTag>
        </div>
        <p class="findings__context">{{ f.context }}</p>
        <section class="findings__group">
          <h4 class="findings__label">{{ t('agents.findings.evidence') }}</h4>
          <ul class="findings__lines mono">
            <li v-for="e in f.evidence" :key="e">{{ e }}</li>
          </ul>
        </section>
        <section class="findings__group">
          <h4 class="findings__label">{{ t('agents.findings.acceptance') }}</h4>
          <ul class="findings__lines">
            <li v-for="a in f.acceptanceCriteria" :key="a">{{ a }}</li>
          </ul>
        </section>
        <section v-if="f.suggestedFix" class="findings__group">
          <h4 class="findings__label">{{ t('agents.findings.suggestedFix') }}</h4>
          <p class="findings__context">{{ f.suggestedFix }}</p>
        </section>
        <div class="findings__foot mono">
          <template v-if="f.status === 'open'">
            <button type="button" class="findings__action" @click="void openFile(f)">{{ t('agents.findings.file') }}</button>
            <button
              type="button"
              class="findings__action findings__action--quiet"
              :disabled="dismissAction.busyFor(f.id)"
              :aria-busy="dismissAction.busyFor(f.id) || undefined"
              @click="dismissAction.run(f.id)"
            ><KSpinner v-if="dismissAction.busyFor(f.id)" :size="10" /> {{ t('agents.findings.dismiss') }}</button>
          </template>
          <template v-else-if="f.target?.kind === 'jira'">
            <span class="findings__state">{{ t('agents.findings.filedJira') }}</span>
            <a class="findings__link" :href="f.target.url" target="_blank" rel="noopener">{{ f.target.key }}</a>
          </template>
          <template v-else-if="f.target?.kind === 'plane'">
            <span class="findings__state">{{ t('agents.findings.filedPlane') }}</span>
            <a class="findings__link" :href="f.target.url" target="_blank" rel="noopener">{{ f.target.key }}</a>
          </template>
          <template v-else-if="f.target?.kind === 'board'">
            <span class="findings__state">{{ t('agents.findings.filedBoard') }}</span>
            <RouterLink class="findings__link" :to="{ name: 'board' }">{{
              cardTitles.get(f.target.taskId) ?? t('agents.findings.card')
            }}</RouterLink>
          </template>
          <span v-else class="findings__state">{{ t('agents.findings.dismissed') }}</span>
        </div>
      </li>
    </ul>
    <p v-else-if="phase === 'ready' && !loadError" class="findings__empty mono">{{ t('agents.findings.empty') }}</p>

    <!-- FINDING → CARD / ISSUE / WORK ITEM — the operator files what the agent proposed. Nothing
         reaches the board, Jira or Plane without this click, and every field can be edited first. -->
    <KModal v-model="dialogOpen" :title="t('agents.findings.dialog.title')" width="720px" :persistent="busy">
      <div class="findings__form">
        <div class="findings__seg" role="radiogroup" :aria-label="t('agents.findings.dialog.target')">
          <button
            type="button"
            role="radio"
            class="findings__seg-btn mono"
            :class="{ 'findings__seg-btn--active': target === 'board' }"
            :aria-checked="target === 'board'"
            @click="target = 'board'"
          >{{ t('agents.findings.dialog.board') }}</button>
          <button
            type="button"
            role="radio"
            class="findings__seg-btn mono"
            :class="{ 'findings__seg-btn--active': target === 'jira' }"
            :aria-checked="target === 'jira'"
            :disabled="!jiraBoards.length"
            @click="target = 'jira'"
          >Jira</button>
          <button
            type="button"
            role="radio"
            class="findings__seg-btn mono"
            :class="{ 'findings__seg-btn--active': target === 'plane' }"
            :aria-checked="target === 'plane'"
            :disabled="!planeProjects.length"
            @click="target = 'plane'"
          >Plane</button>
        </div>
        <p v-if="jiraHint" class="findings__hint mono">{{ jiraHint }}</p>
        <p v-if="planeHint" class="findings__hint mono">{{ planeHint }}</p>
        <!-- Said only once the cloud list has answered: before that, a published project reads
             as absent too. A list that could not be read is said as such, not as «не опубліковано». -->
        <p v-if="!cloudReading && !workspaceId" class="findings__hint mono">
          {{ t(projects.listRead ? 'agents.findings.dialog.notCloud' : 'agents.findings.dialog.cloudUnread') }}
        </p>

        <template v-if="target === 'board'">
          <KSelect
            v-model="project"
            :label="t('agents.findings.dialog.project')"
            :options="projectOptions"
            :loading="cloudReading"
          />
          <KSelect
            v-model="assignee"
            :label="t('agents.findings.dialog.assignee')"
            :options="assigneeOptions"
            :placeholder="t('agents.findings.dialog.unassigned')"
            :loading="membersLoading || cloudReading"
          />
          <!-- «Дозволити автовиконання»: off by default, the operator's own decision per card.
               The card is theirs (they file it), so the author rule never locks it here. -->
          <div class="findings__check">
            <KCheckbox v-model="autoRun" :label="t('minion.autoRun.label')" />
            <p class="findings__check-desc">{{ t('minion.autoRun.caption') }}</p>
          </div>
        </template>
        <template v-else-if="target === 'jira'">
          <KSelect
            v-model="jiraBoard"
            :label="t('agents.findings.dialog.jiraBoard')"
            :options="jiraBoardOptions"
            :loading="jiraProbe === 'pending'"
          />
          <KSelect
            v-model="issueType"
            :label="t('agents.findings.dialog.issueType')"
            :options="issueTypeOptions"
            :loading="issueTypesLoading"
          />
          <!-- Jira's refusal to list the board's issue types belongs to this half only: the
               board is auto-picked on open, so it must not surface on the «Дошка» side. -->
          <p v-if="issueTypesError" class="findings__error" role="alert">{{ issueTypesError }}</p>
        </template>
        <template v-else>
          <KSelect
            v-model="planeProject"
            :label="t('agents.findings.dialog.planeProject')"
            :options="planeProjectOptions"
            :loading="planeProbe === 'pending'"
          />
          <!-- Work-item types are Plane Pro: a project without them gets no type picker, and
               the item is filed untyped. Shown while loading so the field does not pop in. -->
          <KSelect
            v-if="planeOptionsLoading || planeTypeOptions.length"
            v-model="planeIssueType"
            :label="t('plane.issueEditor.typeLabel')"
            :options="planeTypeOptions"
            placeholder="—"
            :loading="planeOptionsLoading"
          />
          <KSelect v-model="planePriority" :label="t('plane.issueEditor.priorityLabel')" :options="planePriorityOptions" />
          <p v-if="planeOptionsError" class="findings__error" role="alert">{{ planeOptionsError }}</p>
        </template>
        <KField v-model="title" :label="t('agents.findings.dialog.taskTitle')" />
        <div>
          <KField ref="descriptionField" v-model="description" :label="t('agents.findings.dialog.description')" multiline :rows="14" @keydown="dictation.onKeydown" />
          <!-- Диктування (docs/specs/2026-11-03-voice-dictation.md). -->
          <KDictation
            class="findings__dictate"
            :state="dictation.state.value"
            :caption="dictation.caption.value"
            :level="dictation.level.value"
            @toggle="dictation.toggle"
          />
        </div>
        <p v-if="dialogError" class="findings__error" role="alert">{{ dialogError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" :disabled="busy" @click="dialogOpen = false">{{ t('agents.finish.close') }}</KBtn>
        <KBtn variant="primary" :loading="busy" :disabled="!canCreate" @click="submit">{{ t('agents.findings.dialog.create') }}</KBtn>
      </template>
    </KModal>
  </div>
</template>

<script setup lang="ts">
// «Знахідки» (docs/specs/2026-10-13-agent-findings.md): what the session's agent noticed
// outside its own task, reported through the `report_finding` MCP tool and kept on this
// machine. The pane lists them; «Створити задачу →» files one as a native board card, a Jira
// issue or a Plane work item, «Відхилити» drops it. The card / issue is created here, under the
// operator's own JWT or tracker token, and only then is the target reported to the api — so a
// failed create leaves the finding open.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { FINDING_JIRA_LABEL, renderFindingDescription, type AgentFinding, type FindingTarget, type Session } from '@kermanych/core';
import { listJiraIntegrations, listPlaneIntegrations, type JiraIntegration, type PlaneIntegration } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { usePlane } from 'stores/plane';
import { api, type JiraEditorOptions, type PlaneEditorOptions } from '../../lib/api';
import { IS_PREVIEW } from '../../lib/preview';
import { handleOf } from '../../lib/members';
import { findingTaskInsert, pickFindingIssueType, pickPlaneFindingIssueType, planeFindingPriority } from '../../lib/findings';
import { PLANE_PRIORITIES, planeIssueUrl, priorityValue } from '../../lib/plane-view';
import KTag from 'components/kit/KTag.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KDictation from 'components/kit/KDictation.vue';
import KBtn from 'components/kit/KBtn.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import { errorText, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useDictationField } from '../../composables/useDictationField';

const props = defineProps<{ session: Session }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
const board = useBoard();
const auth = useAuth();

// ── The list ─────────────────────────────────────────────────────────────
// Reloaded whenever the session's open count moves: a new report arrives as an ordinary
// `session_update`, so the count is the only signal there is.
const findings = ref<AgentFinding[]>([]);
// The session whose list `findings` holds; anything else means «not loaded» (a skeleton), so
// «немає знахідок» is never said about a session whose list has not answered yet. A refresh
// of the same session keeps the rows on screen.
const loadedFor = ref<string | null>(null);
const loadError = ref<string | null>(null);
const phase = useLoadPhase(() => loadedFor.value !== props.session.id && !loadError.value);

async function load(): Promise<void> {
  const id = props.session.id;
  try {
    const list = await api.sessionFindings(id);
    if (props.session.id !== id) return;
    findings.value = list;
    loadedFor.value = id;
    loadError.value = null;
  } catch (e) {
    if (props.session.id === id) loadError.value = errorText(e);
  }
}

watch(
  () => props.session.id,
  () => {
    findings.value = [];
    loadedFor.value = null;
    loadError.value = null;
  },
);
watch(() => [props.session.id, props.session.openFindings], () => void load(), { immediate: true });

// «Відхилити», per finding: the pressed row spins, a failure is a toast.
const dismissAction = useKeyedAction(async (findingId: string) => {
  const sessionId = props.session.id;
  const updated = await api.dismissFinding(sessionId, findingId);
  if (props.session.id !== sessionId) return;
  findings.value = findings.value.map((x) => (x.id === updated.id ? updated : x));
});

// A board card is named by its title when the board store has it loaded (the current
// workspace's cards), else by a plain word — the link goes to the board either way.
const cardTitles = computed(() => new Map(board.tasks.map((c) => [c.id, c.title])));

// ── The filing dialog ────────────────────────────────────────────────────
const dialogOpen = ref(false);
const finding = ref<AgentFinding | null>(null);
const target = ref<'board' | 'jira' | 'plane'>('board');
const title = ref('');
const description = ref('');
const descriptionField = ref<InstanceType<typeof KField> | null>(null);
// Диктування: the description is said rather than typed; closing the dialog drops the phrase.
const dictation = useDictationField({ el: () => descriptionField.value?.el(), value: description });
watch(dialogOpen, (open) => {
  if (!open) dictation.cancel();
});
const project = ref('');
const assignee = ref('');
const autoRun = ref(false);
const dialogError = ref<string | null>(null);
const busy = ref(false);
// The workspace's members are read on the first open; the assignee picker spins meanwhile.
const membersLoading = ref(false);
// The cloud list being re-read because the run never managed to (stores/projects.ts,
// ensureList): until it answers the session's project has no workspace, so both pickers spin
// and the trackers are not probed.
const cloudReading = ref(false);
// A reopened dialog's reads supersede the previous open's late answers.
let openRun = 0;

const home = computed(() => projects.byId.get(props.session.projectId));
const workspaceId = computed(() => home.value?.workspaceId);
// Any project of the session's workspace: a frontend agent often finds a backend problem.
const projectOptions = computed<KSelectOption[]>(() =>
  projects.projects.filter((p) => p.workspaceId === workspaceId.value).map((p) => ({ value: p.id, label: p.name })),
);
const assigneeOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('agents.findings.dialog.unassigned') },
  ...(projects.members[workspaceId.value ?? ''] ?? []).map((m) => ({ value: m.userId, label: handleOf(m) })),
]);

// Jira and Plane alike: the workspace's connected boards / projects for which this machine
// holds the operator's token. Probed per dialog open — a token added meanwhile under
// Менеджмент → Integrations is picked up without a reload.
type TrackerProbe = 'pending' | 'unavailable' | 'noBoard' | 'noToken' | 'ready';
// «Nothing connected» is said about a tracker only while the other one has nothing either: a
// Plane-only workspace must not be told about Jira on every filing, nor a Jira one about Plane.
const noTracker = (p: TrackerProbe) => p === 'noBoard' || p === 'unavailable';
const jiraProbe = ref<TrackerProbe>('pending');
const jiraBoards = ref<JiraIntegration[]>([]);
const jiraBoard = ref('');
const jiraBoardOptions = computed<KSelectOption[]>(() =>
  jiraBoards.value.map((b) => ({ value: b.id, label: `${b.boardName} · ${b.projectKey}` })),
);
const issueTypes = ref<JiraEditorOptions['issueTypes']>([]);
const issueType = ref('');
const issueTypesLoading = ref(false);
const issueTypesError = ref<string | null>(null);
const issueTypeOptions = computed<KSelectOption[]>(() =>
  issueTypes.value.filter((it) => !it.subtask).map((it) => ({ value: it.id, label: it.name })),
);
const jiraHint = computed(() => {
  switch (jiraProbe.value) {
    case 'unavailable':
      return t('agents.findings.dialog.jiraUnavailable');
    case 'noBoard':
      return noTracker(planeProbe.value) ? t('agents.findings.dialog.jiraNoBoard') : '';
    case 'noToken':
      return t('agents.findings.dialog.jiraNoToken');
    case 'pending':
      // Only while the dialog is open and the probe has not answered — the Jira half is
      // disabled meanwhile, and this says why it is not offered yet.
      return t('agents.findings.dialog.jiraProbing');
    default:
      return '';
  }
});

async function probeJira(ws: string | undefined): Promise<void> {
  jiraBoards.value = [];
  jiraBoard.value = '';
  if (IS_PREVIEW || !auth.user || !ws) {
    jiraProbe.value = 'unavailable';
    return;
  }
  jiraProbe.value = 'pending';
  try {
    const rows = await listJiraIntegrations(auth.client, ws);
    if (!rows.length) {
      jiraProbe.value = 'noBoard';
      return;
    }
    const sites = [...new Set(rows.map((r) => r.siteUrl))];
    const present = new Set<string>();
    await Promise.all(
      sites.map(async (site) => {
        if ((await api.jiraTokenStatus(site).catch(() => ({ present: false }))).present) present.add(site);
      }),
    );
    jiraBoards.value = rows.filter((r) => present.has(r.siteUrl));
    jiraProbe.value = jiraBoards.value.length ? 'ready' : 'noToken';
    if (jiraBoards.value.length === 1) jiraBoard.value = jiraBoards.value[0]!.id;
  } catch {
    // An unreachable cloud: the board half is the offline story, Jira simply is not offered.
    jiraProbe.value = 'unavailable';
  }
}

// The issue types belong to the chosen board's Jira project; the default follows the kind.
watch(jiraBoard, async (id) => {
  issueTypes.value = [];
  issueType.value = '';
  issueTypesError.value = null;
  if (!id) return;
  issueTypesLoading.value = true;
  try {
    const opts = await api.jiraEditorOptions(id);
    if (jiraBoard.value !== id) return;
    issueTypes.value = opts.issueTypes;
    issueType.value = (finding.value && pickFindingIssueType(opts.issueTypes, finding.value.kind)) ?? '';
  } catch (e) {
    if (jiraBoard.value === id) issueTypesError.value = errorText(e);
  } finally {
    if (jiraBoard.value === id) issueTypesLoading.value = false;
  }
});

// Plane: a token is keyed by the Plane address AND the Plane workspace slug, so the answer is
// per pair — two connected projects may live in different Plane workspaces.
const plane = usePlane();
const planeProbe = ref<TrackerProbe>('pending');
const planeProjects = ref<PlaneIntegration[]>([]);
const planeProject = ref('');
const planeProjectOptions = computed<KSelectOption[]>(() =>
  planeProjects.value.map((p) => ({ value: p.id, label: `${p.projectName} · ${p.projectIdentifier}` })),
);
const planeIssueTypes = ref<PlaneEditorOptions['issueTypes']>([]);
const planeIssueType = ref('');
const planeOptionsLoading = ref(false);
const planeOptionsError = ref<string | null>(null);
const planeTypeOptions = computed<KSelectOption[]>(() => planeIssueTypes.value.map((it) => ({ value: it.id, label: it.name })));
const planePriority = ref<string>('none');
const planePriorityOptions = computed<KSelectOption[]>(() =>
  PLANE_PRIORITIES.map((p) => ({ value: p, label: t(`plane.priority.${p}`) })),
);
const planeHint = computed(() => {
  switch (planeProbe.value) {
    case 'unavailable':
      return t('agents.findings.dialog.planeUnavailable');
    case 'noBoard':
      return noTracker(jiraProbe.value) ? t('agents.findings.dialog.planeNoBoard') : '';
    case 'noToken':
      return t('agents.findings.dialog.planeNoToken');
    case 'pending':
      return t('agents.findings.dialog.planeProbing');
    default:
      return '';
  }
});
// A reopened dialog's probe supersedes the previous one's late answer.
let planeProbeRun = 0;

async function probePlane(ws: string | undefined): Promise<void> {
  const mine = ++planeProbeRun;
  planeProjects.value = [];
  planeProject.value = '';
  if (IS_PREVIEW || !auth.user || !ws) {
    planeProbe.value = 'unavailable';
    return;
  }
  planeProbe.value = 'pending';
  try {
    const rows = await listPlaneIntegrations(auth.client, ws);
    if (mine !== planeProbeRun) return;
    if (!rows.length) {
      planeProbe.value = 'noBoard';
      return;
    }
    const pairKey = (r: PlaneIntegration) => `${r.siteUrl}\n${r.workspaceSlug}`;
    const pairs = [...new Map(rows.map((r) => [pairKey(r), r])).values()];
    const present = new Set<string>();
    await Promise.all(
      pairs.map(async (r) => {
        const status = await api.planeTokenStatus(r.siteUrl, r.workspaceSlug).catch(() => ({ present: false }));
        if (status.present) present.add(pairKey(r));
      }),
    );
    if (mine !== planeProbeRun) return;
    planeProjects.value = rows.filter((r) => present.has(pairKey(r)));
    planeProbe.value = planeProjects.value.length ? 'ready' : 'noToken';
    // One project is always preselected: the one the Plane board last showed in this
    // workspace when the operator can write to it, else the first.
    planeProject.value = (planeProjects.value.find((p) => p.id === plane.activeId) ?? planeProjects.value[0])?.id ?? '';
  } catch {
    // An unreachable cloud: the board half is the offline story, Plane simply is not offered.
    if (mine === planeProbeRun) planeProbe.value = 'unavailable';
  }
}

// The work-item types belong to the chosen Plane project; the default follows the kind.
watch(planeProject, async (id) => {
  planeIssueTypes.value = [];
  planeIssueType.value = '';
  planeOptionsError.value = null;
  if (!id) return;
  planeOptionsLoading.value = true;
  try {
    const opts = await api.planeEditorOptions(id);
    if (planeProject.value !== id) return;
    planeIssueTypes.value = opts.issueTypes;
    planeIssueType.value = (finding.value && pickPlaneFindingIssueType(opts.issueTypes, finding.value.kind)) ?? '';
  } catch (e) {
    if (planeProject.value === id) planeOptionsError.value = errorText(e);
  } finally {
    if (planeProject.value === id) planeOptionsLoading.value = false;
  }
});

async function openFile(f: AgentFinding): Promise<void> {
  const s = props.session;
  const run = ++openRun;
  finding.value = f;
  target.value = 'board';
  title.value = f.title;
  description.value = renderFindingDescription(f, {
    project: home.value?.name ?? store.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId,
    branch: s.branch,
    session: s.name,
  });
  project.value = home.value?.id ?? '';
  assignee.value = '';
  autoRun.value = false;
  planePriority.value = planeFindingPriority(f.kind);
  dialogError.value = null;
  busy.value = false;
  jiraProbe.value = 'pending';
  planeProbe.value = 'pending';
  dialogOpen.value = true;
  if (!home.value && !projects.listRead) {
    cloudReading.value = true;
    try {
      await projects.ensureList();
    } finally {
      if (run === openRun) cloudReading.value = false;
    }
    if (run !== openRun) return;
    // The picker spun while the list was read, so nothing was picked meanwhile.
    project.value = projects.byId.has(s.projectId) ? s.projectId : '';
  }
  const ws = workspaceId.value;
  if (ws && !projects.members[ws]) {
    membersLoading.value = true;
    void projects
      .loadMembers(ws)
      .catch(() => undefined)
      .finally(() => { membersLoading.value = false; });
  }
  void probeJira(ws);
  void probePlane(ws);
}

const canCreate = computed(() => {
  if (!title.value.trim() || busy.value) return false;
  if (target.value === 'board') return projects.byId.has(project.value);
  if (target.value === 'jira') return !!jiraBoards.value.find((b) => b.id === jiraBoard.value) && !!issueType.value;
  // The type is optional in Plane, but a create before the project's options answer would
  // skip the preselected one.
  return !!planeProjects.value.find((p) => p.id === planeProject.value) && !planeOptionsLoading.value;
});

// Creates the card / issue, then reports the target. Either step's refusal stays in the
// dialog and the finding stays open.
async function createTarget(f: AgentFinding): Promise<FindingTarget | undefined> {
  if (target.value === 'board') {
    const dest = projects.byId.get(project.value);
    if (!dest) return undefined;
    const card = await board.createTask(
      findingTaskInsert(f, dest, {
        title: title.value,
        description: description.value,
        assigneeId: assignee.value,
        autoRun: autoRun.value,
      }),
    );
    if (!card) {
      // The store has already toasted the reason; the dialog keeps the operator's edits.
      dialogError.value = t('agents.findings.dialog.boardFailed');
      return undefined;
    }
    return { kind: 'board', taskId: card.id };
  }
  if (target.value === 'plane') {
    const pp = planeProjects.value.find((p) => p.id === planeProject.value);
    if (!pp) return undefined;
    const item = await api.planeCreateIssue(pp.id, {
      summary: title.value.trim(),
      description: description.value,
      ...(planeIssueType.value ? { issueTypeId: planeIssueType.value } : {}),
      priority: priorityValue(planePriority.value),
      labels: [FINDING_JIRA_LABEL, f.kind],
    });
    return { kind: 'plane', key: item.key, url: planeIssueUrl(pp, item.key) };
  }
  const jb = jiraBoards.value.find((b) => b.id === jiraBoard.value);
  if (!jb) return undefined;
  const issue = await api.jiraCreateIssue(jb.id, {
    summary: title.value.trim(),
    description: description.value,
    issueTypeId: issueType.value,
    labels: [FINDING_JIRA_LABEL, f.kind],
  });
  return { kind: 'jira', key: issue.key, url: `${jb.siteUrl.replace(/\/$/, '')}/browse/${issue.key}` };
}

async function submit(): Promise<void> {
  const f = finding.value;
  if (!f || !canCreate.value) return;
  busy.value = true;
  dialogError.value = null;
  try {
    // The phrase being spoken belongs to the description: it lands before the task is written.
    await dictation.beforeSubmit();
    const dest = await createTarget(f);
    if (!dest) return;
    const updated = await api.fileFinding(props.session.id, f.id, dest);
    findings.value = findings.value.map((x) => (x.id === updated.id ? updated : x));
    dialogOpen.value = false;
    store.notify(
      dest.kind === 'jira'
        ? t('agents.findings.filedJiraNotify', { key: dest.key })
        : dest.kind === 'plane'
          ? t('agents.findings.filedPlaneNotify', { key: dest.key })
          : t('agents.findings.filedBoardNotify', { title: title.value.trim(), project: projects.byId.get(project.value)?.name ?? '' }),
      'info',
    );
  } catch (e) {
    dialogError.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.findings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.findings__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.findings__item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--k-line);
}

// A dismissed finding stays on the list as a record, one step back from the live ones.
.findings__item--dismissed {
  opacity: 0.55;
}

.findings__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.findings__title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--k-text);
}

.findings__kind {
  flex: none;
}

.findings__context {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-text);
  white-space: pre-wrap;
}

.findings__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.findings__label {
  margin: 0;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.findings__lines {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-text);
  word-break: break-word;
}

.findings__foot {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}

.findings__action {
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--k-accent);
  font: inherit;
  cursor: pointer;

  &:hover { text-decoration: underline; }
  &:disabled { opacity: 0.5; cursor: default; text-decoration: none; }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
}

.findings__action--quiet {
  color: var(--k-muted);

  &:hover { color: var(--k-text); }
}

.findings__state {
  color: var(--k-muted);
}

.findings__link {
  color: var(--k-accent);
  text-decoration: none;

  &:hover { text-decoration: underline; }
}

.findings__empty {
  margin: 0;
  font-size: 12px;
  color: var(--k-muted);
}

.findings__dictate {
  margin-top: 6px;
}
.findings__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.findings__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

/* A card switch with its caption under the label, the launcher's layout. */
.findings__check-desc {
  margin: 3px 0 0;
  padding-left: 24px;
  font-size: 11px;
  color: var(--k-muted);
}

.findings__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

// The launcher's segmented picker, for the «Дошка / Jira» switch.
.findings__seg {
  display: flex;
  gap: 2px;
  background: var(--k-line-strong);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  overflow: hidden;
}

.findings__seg-btn {
  flex: 1;
  min-width: 0;
  padding: 7px 8px;
  background: var(--k-bg);
  border: 0;
  color: var(--k-muted);
  font-weight: 500;
  font-size: 12px;
  text-align: center;
  cursor: pointer;

  &:hover:not(:disabled) { color: var(--k-text); }
  &:disabled { cursor: not-allowed; opacity: 0.45; }
}

.findings__seg-btn--active {
  background: var(--k-accent);
  color: var(--k-on-accent);
}
</style>
