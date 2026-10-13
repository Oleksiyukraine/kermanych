<template>
  <section class="rel">
    <p class="rel__lead">
      {{ t('management.releases.leadBefore') }}
      <span class="rel__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.releases.leadAfter') }}
    </p>

    <div class="rel__toolbar">
      <span class="rel__count mono">{{ notes.length ? t('management.releases.count', { count: notes.length }) : '' }}</span>
      <!-- The section's Slack settings: the channel notes are sent to, and the member's
           Slack account they are sent as. The label names the channel once it is set. -->
      <KBtn variant="secondary" @click="slackOpen = true">
        {{ slackRow ? t('releaseSlack.toolbarSet', { channel: slackRow.channelName }) : t('releaseSlack.toolbarUnset') }}
      </KBtn>
      <KBtn variant="primary" @click="openGenerate">{{ t('management.releases.generate') }}</KBtn>
    </div>

    <p v-if="store.loadError" class="rel__error">
      {{ t('management.releases.loadError', { error: store.loadError }) }}
    </p>

    <div v-else-if="!notes.length && !jobs.length" class="rel__blank">
      <span class="rel__blank-eyebrow mono">{{ t('management.releases.blankEyebrow') }}</span>
      <p class="rel__blank-text">
        {{ t('management.releases.blankText') }}
      </p>
    </div>

    <!-- The history. One row per note, newest first — the answer to «що ми відвантажили
         востаннє» is the first line on the screen. Above it, one row per generation still
         running (or failed): the run belongs to the workspace's history, not to a modal, so
         it is placed where its result will appear. -->
    <ol v-else class="rel__list">
      <li
        v-for="j in jobs"
        :key="j.id"
        class="rel__row rel__row--job"
        :class="{ 'rel__row--failed': !!j.error }"
      >
        <div class="rel__row-main">
          <span class="rel__row-title">
            <span v-if="!j.error" class="rel__row-pulse" aria-hidden="true">◆</span>
            {{ j.error ? t('management.releases.jobFailed') : t('management.releases.jobRunning') }}
          </span>
          <span class="rel__row-meta">
            <KTag v-for="s in j.sources" :key="s.projectId">{{ sourceLabel(s) }}</KTag>
            <KTag v-if="j.groupBy === 'person'">{{ t('management.releases.byPersonTag') }}</KTag>
            <span class="rel__row-range mono">{{ j.rangeFrom }} — {{ j.rangeTo }}</span>
          </span>
          <span v-if="j.error" class="rel__row-error">{{ j.error }}</span>
        </div>
        <span v-if="!j.error" class="rel__row-when mono">{{ elapsed(j) }}</span>
        <span v-else class="rel__row-actions">
          <KBtn variant="secondary" @click="store.retry(j.id)">{{ t('management.releases.retry') }}</KBtn>
          <KBtn variant="ghost" @click="store.dismissJob(j.id)">{{ t('management.releases.dismiss') }}</KBtn>
        </span>
      </li>

      <li v-for="n in notes" :key="n.id" class="rel__row" @click="openNote(n)">
        <div class="rel__row-main">
          <span class="rel__row-title">{{ n.title }}</span>
          <span class="rel__row-meta">
            <KTag v-for="(s, i) in n.sources" :key="i">{{ sourceLabel(s) }}</KTag>
            <span class="rel__row-range mono">{{ n.rangeFrom }} — {{ n.rangeTo }}</span>
          </span>
        </div>
        <span class="rel__row-when mono">{{ renderTime(t, relativeTime(n.createdAt, now)) }}</span>
      </li>
    </ol>

    <!-- ── Generation form ─────────────────────────────────────────────────────
         Never persistent, never busy: submitting hands the run to the store and closes,
         so the form holds nothing anybody is waiting on. -->
    <KModal v-model="genOpen" :title="t('management.releases.genTitle')" width="600px">
      <div class="rel__form">
        <!-- One or more projects. Each project IS a shipping shape — its repository is the
             front-end, the back-end or an app — so picking two writes one note with one
             section per project, in the order they were picked. -->
        <KSelect
          multiple
          :values="pickedProjects.map((p) => p.id)"
          :label="t('management.releases.projectLabel')"
          :options="projectOptions"
          :summary="projectSummary"
          @update:values="pickProjects"
        />
        <!-- One branch per picked project, in section order: the back-end may ship from
             `dev` while the front-end ships from `main`. `searchable`: the options are the
             bound repo's whole `refs/heads`, and a release is written off a release branch
             whose name the operator knows — so the way to it is to type it. -->
        <div v-if="pickedProjects.length" class="rel__form-branches">
          <KSelect
            v-for="p in pickedProjects"
            :key="p.id"
            :model-value="gen.branches[p.id] ?? ''"
            :label="t('management.releases.branchFor', { project: p.name })"
            :options="branchLists[p.id]?.branches ?? []"
            :placeholder="branchPlaceholder(p.id)"
            :disabled="!branchLists[p.id]?.branches.length"
            searchable
            @update:model-value="(v: string) => (gen.branches[p.id] = v)"
          />
        </div>
        <p v-if="pickedProjects.length > 1" class="rel__form-hint">
          {{ t('management.releases.multiHint') }}
        </p>

        <div class="rel__form-range">
          <KDateField v-model="gen.rangeFrom" :label="t('management.releases.rangeFromLabel')" />
          <KDateField v-model="gen.rangeTo" :label="t('management.releases.rangeToLabel')" />
        </div>

        <!-- Off by default: the note is the by-topic document it always was. On, it is one
             section per commit author in the period, each in the same plain language. -->
        <KCheckbox v-model="gen.byPerson" :label="t('management.releases.byPersonLabel')" />

        <!-- Where the material comes from and what pressing the button costs, said before
             it is pressed: the commits are read from THIS machine's clone, the writing
             spends the same provider plan every agent spends, and it keeps going while the
             operator does something else. -->
        <p class="rel__form-hint">
          {{ t('management.releases.formHint') }}
        </p>
      </div>

      <template #controls>
        <KBtn variant="ghost" @click="genOpen = false">{{ t('management.releases.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="!canGenerate" @click="submitGenerate">
          {{ t('management.releases.generateSubmit') }}
        </KBtn>
      </template>
    </KModal>

    <!-- ── One note: read, copy, edit ──────────────────────────────────────────
         Persistent while editing: a click past the modal's edge must not discard a
         half-rewritten document. -->
    <KModal
      :model-value="!!current"
      :title="current?.title ?? ''"
      width="820px"
      :persistent="editing || saving"
      @update:model-value="(v: boolean) => { if (!v) closeNote(); }"
    >
      <template #head-meta>
        <span v-if="current" class="rel__doc-meta">
          <KTag v-for="(s, i) in current.sources" :key="i">{{ sourceLabel(s) }}</KTag>
          <KTag>{{ current.rangeFrom }} — {{ current.rangeTo }}</KTag>
        </span>
      </template>

      <template v-if="current">
        <div v-if="!editing" class="rel__doc">
          <!-- renderMarkdown escapes raw HTML (markdown-it html:false), so v-html is a
               controlled tag set — the same guarantee the assistant transcript relies on. -->
          <div class="k-log__markdown" v-html="renderMarkdown(current.bodyMd)"></div>
          <p class="rel__doc-audit mono">
            {{ t('management.releases.auditGenerated') }} {{ memberName(current.createdBy) }} · {{ renderTime(t, relativeTime(current.createdAt, now)) }}
            <template v-if="current.updatedAt !== current.createdAt">
              · {{ t('management.releases.auditEdited') }} {{ memberName(current.updatedBy) }} · {{ renderTime(t, relativeTime(current.updatedAt, now)) }}
            </template>
          </p>
        </div>

        <div v-else class="rel__edit">
          <KField v-model="draftTitle" :label="t('management.releases.editTitle')" :disabled="saving" />
          <KField
            v-model="draftBody"
            :label="t('management.releases.editBody')"
            multiline
            :rows="18"
            :disabled="saving"
          />
          <p v-if="editError" class="rel__form-error">{{ editError }}</p>
        </div>
      </template>

      <template #controls>
        <template v-if="!editing">
          <KBtn variant="secondary" @click="startEdit">{{ t('management.releases.edit') }}</KBtn>
          <!-- Posted under the pressing member's own Slack name. Without a channel it opens
               the Slack settings, which say who sets one. -->
          <KBtn
            v-tip="slackRow ? t('releaseSlack.sendTip', { channel: slackRow.channelName }) : ''"
            variant="secondary"
            :loading="sending"
            @click="sendToSlack"
          >
            {{ sent ? t('releaseSlack.sent') : t('releaseSlack.send') }}
          </KBtn>
          <KBtn variant="primary" @click="copy">{{ copied ? t('management.releases.copied') : t('management.releases.copy') }}</KBtn>
        </template>
        <template v-else>
          <KBtn variant="ghost" :disabled="saving" @click="cancelEdit">{{ t('management.releases.cancel') }}</KBtn>
          <KBtn variant="primary" :disabled="saving || !draftTitle.trim() || !draftBody.trim()" @click="saveEdit">
            {{ saving ? t('management.releases.saving') : t('management.releases.save') }}
          </KBtn>
        </template>
      </template>
    </KModal>

    <ReleaseSlackModal v-model="slackOpen" :workspace-id="workspaceId" />
  </section>
</template>

<script setup lang="ts">
// Release Notes — the Менеджмент section that turns a branch's git history into a document
// a non-technical reader can use. The shell above (ManagementPage) already renders the
// heading, the workspace chip and the «pick a workspace» gate, so this component renders
// only the section itself and can assume a workspace.
//
// The feature is split across two parties and this component only wires them together:
//   * stores/release-notes.ts OWNS a generation end to end — the local api writes the
//     document, the store lands it in the workspace under the operator's own JWT — which is
//     what lets the operator leave this screen the moment they press the button;
//   * this screen collects the parameters, renders the running job as a row in the history
//     it will land in, and reads, copies and edits what is stored.
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceReleaseNote } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
import KField from 'components/kit/KField.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import { useReleaseNotes, type ReleaseNotesJob } from 'stores/release-notes';
import { useReleaseSlack } from 'stores/release-slack';
import ReleaseSlackModal from 'components/releases/ReleaseSlackModal.vue';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { renderMarkdown } from '../lib/markdown';
import { relativeTime, renderTime } from '../lib/time';
import { useNow } from '../composables/useNow';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const store = useReleaseNotes();
const slack = useReleaseSlack();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);

const { t } = useI18n();

// The history is read on open and whenever the sidebar moves to another workspace. No
// Realtime channel: see the header of stores/release-notes.ts.
watch(
  () => props.workspaceId,
  (id) => {
    if (id) {
      void store.load(id);
      void slack.load(id);
    }
  },
  { immediate: true },
);

// Author names for the audit line. Same source the risks page uses.
watch(
  () => props.workspaceId,
  (id) => {
    if (id && !projects.members[id]) void projects.loadMembers(id);
  },
  { immediate: true },
);

const notes = computed<WorkspaceReleaseNote[]>(() => store.byWorkspace[props.workspaceId] ?? []);

function memberName(id: string | undefined): string {
  if (!id) return '—';
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === id);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? id;
}

// ── Generation ────────────────────────────────────────────────────────────────

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const genOpen = ref(false);
const gen = reactive({
  // The picked projects, in the order they were picked — the order of the note's sections.
  projectIds: [] as string[],
  // The branch picked for each project, kept while the form lives so unticking a project
  // and ticking it again does not lose the branch the operator chose.
  branches: {} as Record<string, string>,
  rangeFrom: '',
  rangeTo: '',
  byPerson: false,
});

// The workspace's projects, with the binding state said IN the picker: an unbound project
// is still choosable (the error will name the machine), but the operator should not have
// to press «Згенерувати» to learn why nothing can come back.
const workspaceProjects = computed(() => projects.projects.filter((p) => p.workspaceId === props.workspaceId));
const projectOptions = computed<KSelectOption[]>(() =>
  workspaceProjects.value.map((p) => {
    const bound = !!local.projects.find((lp) => lp.id === p.id)?.localRepoPath;
    return { value: p.id, label: bound ? p.name : t('management.releases.projectUnbound', { name: p.name }) };
  }),
);

// The picked projects of THIS workspace in pick order: an id left over from the workspace
// the sidebar showed before is not a project this note can cover.
const pickedProjects = computed(() =>
  gen.projectIds.flatMap((id) => workspaceProjects.value.find((p) => p.id === id) ?? []),
);

const projectSummary = computed(() =>
  pickedProjects.value.length
    ? pickedProjects.value.map((p) => p.name).join(', ')
    : t('management.releases.projectPlaceholder'),
);

// Branches of each picked project's local clone. The DEFAULT selection is the project's
// default branch from its settings — the user's requirement — falling back to the repo's
// current HEAD; each picker then lets the operator switch to any local branch.
const branchLists = ref<Record<string, { branches: string[]; failed: boolean }>>({});

function branchPlaceholder(projectId: string): string {
  return branchLists.value[projectId]?.failed
    ? t('management.releases.branchPlaceholderFailed')
    : t('management.releases.branchPlaceholderEmpty');
}

// A newly picked project reads its branches fresh — the clone may have grown a release
// branch since the form was last open — and keeps the branch already chosen for it if that
// branch still exists.
async function loadBranches(projectId: string): Promise<void> {
  try {
    const info = await local.listBranches(projectId);
    branchLists.value = { ...branchLists.value, [projectId]: { branches: info.branches, failed: false } };
    const kept = gen.branches[projectId];
    gen.branches[projectId] =
      kept && info.branches.includes(kept) ? kept : (info.default ?? info.current ?? info.branches[0] ?? '');
  } catch {
    // GET /projects/:id/branches answers `project not bound` without a binding — the
    // placeholder says so, and the generate button stays disabled without a branch.
    branchLists.value = { ...branchLists.value, [projectId]: { branches: [], failed: true } };
    gen.branches[projectId] = '';
  }
}

function pickProjects(ids: string[]): void {
  const added = ids.filter((id) => !gen.projectIds.includes(id));
  gen.projectIds = ids;
  for (const id of added) void loadBranches(id);
}

function openGenerate(): void {
  gen.rangeFrom = gen.rangeFrom || isoDaysAgo(30);
  gen.rangeTo = gen.rangeTo || isoDaysAgo(0);
  genOpen.value = true;
}

const canGenerate = computed(
  () =>
    pickedProjects.value.length > 0 &&
    pickedProjects.value.every((p) => !!gen.branches[p.id]) &&
    gen.rangeFrom !== '' &&
    gen.rangeTo !== '',
);

// Hand the run to the store and close. Nothing is awaited here on purpose: this component
// is unmounted the moment the operator opens another section, and the document must not
// depend on it still being alive. Failures are not this function's business either — they
// arrive as the job's own row, which is readable from any screen at any later moment.
function submitGenerate(): void {
  if (!canGenerate.value) return;
  void store.generate({
    workspaceId: props.workspaceId,
    workspaceName: props.workspaceName,
    sources: pickedProjects.value.map((p) => ({
      projectId: p.id,
      projectName: p.name,
      branch: gen.branches[p.id] ?? '',
    })),
    rangeFrom: gen.rangeFrom,
    rangeTo: gen.rangeTo,
    groupBy: gen.byPerson ? 'person' : 'topic',
  });
  genOpen.value = false;
}

// A project and the branch it was read from, as one tag: with two projects on the row, two
// loose branch tags would not say which branch belongs to which project.
function sourceLabel(s: { projectName: string; branch: string }): string {
  return `${s.projectName} · ${s.branch}`;
}

// The running jobs of THIS workspace, rendered above its history.
const jobs = computed<ReleaseNotesJob[]>(() =>
  store.jobs.filter((j) => j.workspaceId === props.workspaceId),
);

// Honest waiting, now on the row instead of a button: a generation legitimately runs for
// tens of seconds (the model may read the code behind vague commits), and a placeholder
// with no clock reads as a stall. The ticker exists ONLY while something is running —
// `startedAt` lives in the store, so leaving and returning resumes the same count instead
// of restarting it, and an idle screen is not re-rendered once a second for nothing.
const tick = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;

watch(
  () => jobs.value.some((j) => !j.error),
  (running) => {
    if (running === !!ticker) return;
    if (running) {
      tick.value = Date.now();
      ticker = setInterval(() => (tick.value = Date.now()), 1000);
    } else {
      clearInterval(ticker);
      ticker = undefined;
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

function elapsed(job: ReleaseNotesJob): string {
  const sec = Math.max(0, Math.round((tick.value - job.startedAt) / 1000));
  return sec < 3 ? t('management.releases.elapsedJustNow') : t('management.releases.elapsedSec', { sec });
}

// ── One note ─────────────────────────────────────────────────────────────────

const current = ref<WorkspaceReleaseNote | undefined>(undefined);
const editing = ref(false);
const saving = ref(false);
const editError = ref('');
const copied = ref(false);
const draftTitle = ref('');
const draftBody = ref('');

function openNote(n: WorkspaceReleaseNote): void {
  current.value = n;
  editing.value = false;
  copied.value = false;
}

function closeNote(): void {
  current.value = undefined;
  editing.value = false;
}

async function copy(): Promise<void> {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(current.value.bodyMd);
    // Feedback on the button itself — the cursor is already there — then the label returns
    // so the button never permanently claims a clipboard it may no longer hold.
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

const slackOpen = ref(false);
const slackRow = computed(() => slack.settings[props.workspaceId] ?? null);
const sending = ref(false);
const sent = ref(false);

// The store connects the member's Slack account first when there is none on this machine,
// so this is one press whoever presses it. Feedback on the button, like Copy, plus a toast
// naming the channel — the post is public and under the member's name.
async function sendToSlack(): Promise<void> {
  const note = current.value;
  if (!note || sending.value) return;
  if (!slackRow.value) {
    slackOpen.value = true;
    return;
  }
  sending.value = true;
  try {
    const res = await slack.send(props.workspaceId, note.id);
    sent.value = true;
    setTimeout(() => (sent.value = false), 2000);
    local.notify(t('releaseSlack.notify.sent', { title: note.title, channel: `#${res.channelName}` }), 'info');
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    sending.value = false;
  }
}

function startEdit(): void {
  if (!current.value) return;
  draftTitle.value = current.value.title;
  draftBody.value = current.value.bodyMd;
  editError.value = '';
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  editError.value = '';
}

async function saveEdit(): Promise<void> {
  const note = current.value;
  if (!note) return;
  saving.value = true;
  editError.value = '';
  try {
    current.value = await store.save(props.workspaceId, note.id, {
      title: draftTitle.value.trim(),
      bodyMd: draftBody.value,
    });
    editing.value = false;
  } catch (e) {
    // The document stays in the fields: a refused write must not cost the rewrite.
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.rel {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // A comfortable reading measure, unlike the full-width register: a note row carries a
  // sentence, not thirteen facts.
  width: 100%;
  max-width: 960px;
  padding: var(--k-sp-3) 0;
}

.rel__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.rel__lead-workspace {
  color: var(--k-text);
}

.rel__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
}

// `margin-right: auto` keeps the count left and both buttons together on the right.
.rel__count {
  margin-right: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rel__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

.rel__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-5) var(--k-sp-4);
  border: var(--k-rule-thin) dashed var(--k-line);
  border-radius: var(--k-r-lg);
}

.rel__blank-eyebrow {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--k-faint);
}

.rel__blank-text {
  margin: 0;
  max-width: 560px;
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
}

.rel__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.rel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 120ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--k-accent) 45%, var(--k-line));
  }
}

.rel__row-main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  min-width: 0;
}

.rel__row-title {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: 650;
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rel__row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-1);
}

.rel__row-range {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rel__row-when {
  flex-shrink: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// A row for something that is not a document yet: dashed like the empty state, so the
// history reads as «three notes and one being written» rather than four notes, and not
// clickable, because there is nothing to open.
.rel__row--job {
  cursor: default;
  border-style: dashed;
  border-color: color-mix(in srgb, var(--k-accent) 40%, var(--k-line));

  &:hover {
    border-color: color-mix(in srgb, var(--k-accent) 40%, var(--k-line));
  }
}

.rel__row--failed {
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line));

  &:hover {
    border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line));
  }
}

// The same pulsing marker a running tool row carries in the transcript (KToolRow): one
// vocabulary for «this is happening right now» across the app. Scoped `@keyframes` names
// are hash-rewritten per SFC, so the animation cannot be reused by name — this is it,
// declared locally.
.rel__row-pulse {
  margin-right: var(--k-sp-1);
  // Was 10.5px, the only half-pixel size in the app — it rounded differently per zoom level,
  // so the marker's weight changed as the operator resized. `xs` is the floor for a mark.
  font-size: var(--k-icon-xs);
  color: var(--k-accent);
  animation: rel-pulse 1.4s ease-in-out infinite;
}

@keyframes rel-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.rel__row-error {
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-danger);
}

.rel__row-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--k-sp-2);
}

// ── Generation form ───────────────────────────────────────────────────────────

.rel__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

// One branch picker per picked project, two to a row: «Backend» and «Frontend» side by side
// read as the pair the note is about.
.rel__form-branches {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-3);
}

.rel__form-range {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-2);
}

.rel__form-hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-faint);
}

.rel__form-error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

// ── One note ──────────────────────────────────────────────────────────────────

.rel__doc {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rel__doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-1);
}

.rel__doc-audit {
  margin: 0;
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rel__edit {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
</style>
