<template>
  <!-- «Дослідження» (docs/specs/2026-11-16-research-mode.md): the second panel of the avatar
       window's accordion. A read-only agent session (`kind: 'chat'`) that answers questions about
       the code of the workspace's projects and researches features; it writes nothing. Expanded
       it is the session's bar over the same bare KPanel the Агенти detail renders, composer
       included; folded it is the title bar that hands the accordion back. -->
  <div class="rs" :class="{ 'rs--folded': folded }">
    <section class="rs__box" :aria-label="t('research.title')">
      <header class="rs__head">
        <button
          class="rs__toggle"
          type="button"
          :aria-expanded="!folded"
          :aria-label="folded ? t('research.expand') : t('research.fold')"
          @click="emit('toggle')"
        >
          <span class="rs__caret" :class="{ 'rs__caret--open': !folded }" aria-hidden="true"></span>
          <span class="rs__title mono">{{ t('research.title') }}</span>
          <span v-if="folded && research.busy" class="rs__busy mono" aria-live="polite">{{ t('research.busyShort') }}</span>
        </button>
        <template v-if="!folded">
          <button
            ref="historyAnchor"
            type="button"
            class="rs__history-btn mono"
            aria-haspopup="menu"
            :aria-expanded="history.open.value"
            :disabled="!research.list.length"
            @click="history.toggle()"
          >{{ t('research.history') }} <span class="rs__count">{{ research.list.length }}</span> ▾</button>
          <KIconButton
            :loading="creating"
            :disabled="!homeProject"
            :title="t('research.new')"
            @click="newResearch"
          >+</KIconButton>
        </template>
      </header>

      <div v-show="!folded" class="rs__main">
        <template v-if="session">
          <div class="rs__bar">
            <div class="rs__id">
              <KStatusDot :status="session.status" />
              <input
                v-if="renaming"
                ref="renameInput"
                v-model="renameDraft"
                class="rs__rename"
                :aria-label="t('research.renameAria')"
                @keydown.enter.prevent="commitRename"
                @keydown.esc.prevent.stop="cancelRename"
                @blur="commitRename"
              />
              <span v-else class="rs__name" v-tip="t('research.renameHint')" @dblclick="startRename">{{ displayTitle(session) }}</span>
              <span class="rs__project mono">{{ projectName(session.projectId) }}</span>
            </div>
            <div class="rs__actions">
              <button
                v-if="(session.openFindings ?? 0) > 0 || showFindings"
                type="button"
                class="rs__findings mono"
                :aria-pressed="showFindings"
                @click="showFindings = !showFindings"
              >{{ t('agents.tabs.findings') }} <span class="rs__count">{{ session.openFindings ?? 0 }}</span></button>
              <ResearchPromote
                :projects="promoteProjects"
                :home-project-id="session.projectId"
                :busy="promoting"
                :disabled="sessionPending || !hasQuestion || !promoteProjects.length"
                @promote="(projectId, deep) => promote(projectId, deep)"
              />
              <KIconButton
                :loading="filing"
                :disabled="sessionPending || !hasQuestion"
                :title="t('research.toBacklog')"
                @click="toBacklog(openingQuestion)"
              >⊕</KIconButton>
              <KIconButton
                class="rs__close"
                :loading="archivingThread(session.id)"
                :disabled="sessionPending"
                :title="t('research.archive')"
                @click="archiveThread(session.id)"
              >✕</KIconButton>
            </div>
          </div>
          <p v-if="!promoteProjects.length && hasQuestion" class="rs__note">{{ t('research.promoteUnavailable') }}</p>

          <div v-if="showFindings" class="rs__findings-pane">
            <SessionFindings :session="session" />
          </div>
          <KPanel
            v-show="!showFindings"
            ref="panelEl"
            class="rs__panel"
            :bare="true"
            :session="session"
            :refreshing="refreshing || resumingId === session.id"
            :stopping="stopping"
            :restarting="restarting"
            :summarizing="summarizing"
            :pending="sessionPending"
            :answering="answering"
            :outgoing="store.outgoing[session.id] ?? []"
            :model-override="modelPick.value.value"
            :effort-override="effortPick.value.value"
            :model-loading="modelPick.pending.value"
            :effort-loading="effortPick.pending.value"
            :composer-disabled="logPhase !== 'ready'"
            :models="store.models"
            :placeholder="t('research.placeholder')"
            :voiceable="true"
            :voice="voicePanel.bar.value"
            :voice-modes="voicePanel.live"
            :voice-mode="voicePanel.mode.value"
            :dictation="voicePanel.dictation.value"
            @stop="onStop"
            @send="onSend"
            @answer="onAnswer"
            @restart="onRestart"
            @refresh="onRefresh"
            @summary="onSummary"
            @new-task="toBacklog"
            @effort="effortPick.set"
            @set-model="onSetModel"
            @voice-start="voicePanel.start"
            @voice-mode="voicePanel.pick"
            @dictate="voicePanel.toggleDictation"
            @voice-mute="voicePanel.mute"
            @voice-end="voicePanel.end"
          >
            <KSkeleton v-if="logPhase === 'skeleton'" variant="rows" :rows="4" class="rs__skeleton" />
            <template v-else-if="logPhase === 'ready'">
              <template v-if="blocks.length">
                <KRequestBlock
                  v-for="(block, i) in blocks"
                  :key="session.id + ':' + block.id"
                  :block="block"
                  :session-id="session.id"
                  :open="i === blocks.length - 1"
                  :expand-all="EXPAND_ALL_NONE"
                />
              </template>
              <div v-else class="rs__hello">
                <p class="rs__hello-text">{{ t('research.hello', { project: projectName(session.projectId) }) }}</p>
                <p class="rs__hello-note">{{ t('research.helloNote') }}</p>
              </div>
            </template>
          </KPanel>
        </template>
        <div v-else-if="detailPhase === 'skeleton'" class="rs__wait">
          <KSkeleton variant="line" width="40%" />
          <KSkeleton variant="rows" :rows="4" />
        </div>
        <div v-else-if="detailPhase === 'ready'" class="rs__blank">
          <!-- A research that could not start says why where it would have been, with a retry:
               the toast alone is gone in seconds and the empty panel would read as «nothing here». -->
          <template v-if="createError">
            <p class="rs__blank-text">{{ t('research.createFailed', { error: createError }) }}</p>
            <KBtn variant="secondary" :loading="retrying" @click="retry">{{ t('research.retry') }}</KBtn>
          </template>
          <p v-else class="rs__blank-text">{{ blankText }}</p>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div v-if="history.open.value" ref="historyMenu" class="rs__menu" role="menu" :aria-label="t('research.history')">
        <div v-for="s in research.list" :key="s.id" class="rs__row" :class="{ 'rs__row--on': s.id === research.selectedId }">
          <button type="button" class="rs__row-main" role="menuitem" @click="pickResearch(s.id)">
            <KStatusDot :status="s.status" />
            <span class="rs__row-text">
              <span class="rs__row-title">{{ displayTitle(s) }}</span>
              <span class="rs__row-meta mono">{{ projectName(s.projectId) }} · {{ renderTime(t, relativeTime(s.lastActivityAt, now)) }}</span>
            </span>
          </button>
          <KIconButton
            :loading="archivingThread(s.id)"
            :disabled="pending.isPending('session:' + s.id)"
            :title="t('research.archiveNamed', { title: displayTitle(s) })"
            @click="archiveThread(s.id)"
          >✕</KIconButton>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// The logic is the former «Чат» page's (pages/ChatPage.vue, removed): resume on open, reuse an
// empty research instead of stacking new ones, archive as a soft hide, rename in place, promote
// into an agent. What changed is the scope — the workspace, not one project — and the home.
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { buildChatBlocks, taskNameFromText } from '@kermanych/core';
import type { ImageInput, RpcExtensionUIResponse, Session, ThinkingLevel } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { useResearch } from 'stores/research';
import { useAssistantOverlay } from 'stores/assistant-overlay';
import { PENDING_TIMEOUT_MS, usePending } from 'stores/pending';
import type { MessageMode } from '../../lib/api';
import { taskInsertFromDraft } from '../../lib/tasks-view';
import { EXPAND_ALL_NONE } from '../../lib/expand-all';
import { relativeTime, renderTime } from '../../lib/time';
import { nextMode as modeFor } from '../../lib/message-mode';
import { researchHomeProject, researchTitle } from '../../lib/research';
import { historyLoadFor } from '../../lib/open-session-history';
import { useNow } from '../../composables/useNow';
import { useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useVoicePanel } from '../../composables/useVoicePanel';
import type { ComposerDictationHost } from '../../composables/useComposerDictation';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useHeldTranscript } from '../../composables/useHeldTranscript';
import { useAnchoredMenu } from '../../composables/useAnchoredMenu';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import SessionFindings from 'components/agents/SessionFindings.vue';
import ResearchPromote from './ResearchPromote.vue';

const props = defineProps<{ folded?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const store = useOrchestrator();
const board = useBoard();
const auth = useAuth();
const projects = useProjects();
const research = useResearch();
const overlay = useAssistantOverlay();
const pending = usePending();
const router = useRouter();
const now = useNow();

const session = computed(() => research.selected);
const panelEl = ref<(ComponentPublicInstance & { restoreDraft: (text: string, images: readonly ImageInput[]) => void; dictationHost: ComposerDictationHost; $el: HTMLElement }) | null>(null);
const showFindings = ref(false);

function projectName(id: string): string {
  return store.projects.find((p) => p.id === id)?.name ?? projects.byId.get(id)?.name ?? '';
}

// Where «+» starts a research (lib/research.ts): none when no project of the scope is bound here.
const homeProject = computed(() =>
  researchHomeProject(store.projects, research.scopeIds, store.selectedProjectId, session.value?.projectId),
);
const blankText = computed(() => {
  if (!research.scopeIds.length) return t('research.blankScope');
  return t('research.blankBind');
});

// Promotion mints a cloud card and grows a worktree: only cloud projects bound on this machine.
const promoteProjects = computed(() =>
  store.projects
    .filter((p) => research.scopeIds.includes(p.id) && p.localRepoPath !== '' && projects.byId.has(p.id))
    .map((p) => ({ id: p.id, name: p.name })),
);

// The opening question: the server stamps `task` with the first message.
const openingQuestion = computed(() => session.value?.task.trim() ?? '');
const hasQuestion = computed(() => openingQuestion.value !== '');
const sessionPending = computed(() => !!session.value && pending.isPending('session:' + session.value.id));

// ── Load and resume ─────────────────────────────────────────────────────
// Opening a research puts its log on screen the way opening an agent does (historyLoadFor): a
// resume when the api may have reaped the child, a plain read while a turn runs. Only while
// the panel is expanded — a folded panel spawns nothing.
const resumingId = ref<string | undefined>(undefined);
const refreshing = ref(false);
const logFailed = ref<Set<string>>(new Set());
const logPhase = useLoadPhase(
  () => !!session.value && store.transcripts[session.value.id] === undefined && !logFailed.value.has(session.value.id),
);
useHeldTranscript(() => (props.folded ? undefined : research.selectedId));

async function loadLog(id: string): Promise<void> {
  try {
    await store.loadTranscript(id);
  } catch {
    logFailed.value = new Set(logFailed.value).add(id);
  }
}

let resumedId: string | undefined;
async function resumeOpen(id: string): Promise<void> {
  resumedId = id;
  resumingId.value = id;
  try {
    await store.resumeSession(id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
    if (store.transcripts[id] === undefined) await loadLog(id);
  } finally {
    if (resumingId.value === id) resumingId.value = undefined;
  }
}

// The panel always shows a research of the current scope: the selected one while it is in
// scope and not archived, else the most recent one, else a new one in the home project. A
// research just created is selected before its row reaches the store (the socket brings it):
// `awaiting` keeps that gap from reading as «nothing selected» and creating another.
const ensuring = ref(false);
const createError = ref('');
let awaiting: string | undefined;
const detailPhase = useLoadPhase(() => ensuring.value || (!!research.selectedId && !session.value));
function select(id: string, created = false): void {
  if (created) awaiting = id;
  research.selectedId = id;
}
async function ensure(): Promise<void> {
  if (props.folded || ensuring.value) return;
  const cur = session.value;
  if (!cur && awaiting !== undefined && research.selectedId === awaiting) return;
  if (cur && !cur.archived && research.scopeIds.includes(cur.projectId)) return;
  const first = research.list[0];
  if (first) {
    select(first.id);
    return;
  }
  const home = homeProject.value;
  research.selectedId = undefined;
  if (!home) return;
  ensuring.value = true;
  createError.value = '';
  try {
    const created = await store.createChat(home.id);
    if (research.scopeIds.includes(home.id)) select(created.id, true);
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    ensuring.value = false;
  }
}
const { run: retry, busy: retrying } = useAsyncAction(ensure);
watch(
  () => [props.folded, research.scopeIds.join('|'), session.value?.id, session.value?.archived, research.list.length] as const,
  () => void ensure(),
  { immediate: true },
);
// Put the open research's log on screen once per opening, when its row is there.
watch(
  () => [session.value?.id, props.folded] as const,
  ([id, folded]) => {
    const s = session.value;
    if (!id || !s || folded || resumedId === id) return;
    resumedId = id;
    if (historyLoadFor(s) === 'resume') void resumeOpen(id);
    else void loadLog(id);
  },
  { immediate: true },
);
watch(
  () => research.selectedId,
  () => {
    showFindings.value = false;
    renaming.value = false;
  },
);

// «+» — a new research in the home project; an empty one there is reused, so the history does
// not fill with blank rows nobody typed in.
function isEmptyResearch(s: Session): boolean {
  const tr = store.transcripts[s.id];
  if (tr) return !tr.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !s.task.trim();
}
const { run: newResearch, busy: creating } = useAsyncAction(async () => {
  const home = homeProject.value;
  if (!home) return;
  const blank = research.list.find((s) => s.projectId === home.id && isEmptyResearch(s));
  if (blank) {
    select(blank.id);
    return;
  }
  const created = await store.createChat(home.id);
  select(created.id, true);
});

// ── History ─────────────────────────────────────────────────────────────
const historyAnchor = ref<HTMLElement | null>(null);
const historyMenu = ref<HTMLElement | null>(null);
const history = useAnchoredMenu(historyAnchor, historyMenu);
function pickResearch(id: string): void {
  history.close();
  select(id);
}

// Archive — a soft hide: the transcript and the omp session survive. The row stays (blocked)
// until the store reports it archived; the panel then moves to another research (ensure).
const { run: archiveThread, busyFor: archivingThread } = useKeyedAction(async (id: string) => {
  await store.archiveSession(id);
  pending.mark('session:' + id, () => {
    const s = store.sessions.find((x) => x.id === id);
    return !s || s.archived === true;
  });
});

// ── Rename ──────────────────────────────────────────────────────────────
// A rename shows at once and is held until the session row echoes it.
const pendingNames = ref<Record<string, string>>({});
function displayTitle(s: Session): string {
  return pendingNames.value[s.id] ?? researchTitle(s);
}
function dropPendingName(id: string, name: string): void {
  if (pendingNames.value[id] !== name) return;
  const { [id]: _dropped, ...rest } = pendingNames.value;
  pendingNames.value = rest;
}
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
function startRename(): void {
  if (!session.value) return;
  renameDraft.value = displayTitle(session.value);
  renaming.value = true;
  void nextTick(() => renameInput.value?.select());
}
function cancelRename(): void {
  renaming.value = false;
}
async function commitRename(): Promise<void> {
  if (!renaming.value) return;
  renaming.value = false;
  const s = session.value;
  const name = renameDraft.value.trim();
  if (!s || !name || name === displayTitle(s)) return;
  const id = s.id;
  pendingNames.value = { ...pendingNames.value, [id]: name };
  try {
    await store.renameSession(id, name);
  } catch (e) {
    dropPendingName(id, name);
    store.notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  const echoed = () => store.sessions.find((x) => x.id === id)?.name?.trim() === name;
  if (echoed()) {
    dropPendingName(id, name);
    return;
  }
  const timer = setTimeout(() => {
    stopWatch();
    dropPendingName(id, name);
  }, PENDING_TIMEOUT_MS);
  const stopWatch = watch(echoed, (done) => {
    if (!done) return;
    clearTimeout(timer);
    stopWatch();
    dropPendingName(id, name);
  });
}

// ── Promote and file ────────────────────────────────────────────────────
// ▶ (decision 7): a card assigned to me in the chosen project — «Глибокий аналіз» when asked —
// then the research turns into that card's agent in place, and the window steps aside onto it.
const { run: promote, busy: promoting } = useAsyncAction(async (projectId: string, deep: boolean) => {
  const s = session.value;
  const userId = auth.user?.id;
  if (!s || !userId || sessionPending.value) return;
  const card = await board.createTask(
    taskInsertFromDraft(
      {
        name: taskNameFromText(openingQuestion.value) || displayTitle(s),
        task: openingQuestion.value,
        model: s.model,
        prefix: 'feature',
        worktree: true,
        hidden: false,
        deepAnalysis: deep,
        autoRun: false,
      },
      projectId,
      userId,
    ),
  );
  if (!card) return; // the board store has said why
  await store.promoteChat(s.id, card.id);
  research.selectedId = undefined;
  overlay.close();
  store.selectProject(projectId);
  store.setBucket('agents');
  store.selectSession(s.id);
  void router.push({ name: 'agents' });
});

// ⊕ and a text selection in the log: a backlog card in the research's project, assigned to me.
const { run: toBacklog, busy: filing } = useAsyncAction(async (text: string) => {
  const s = session.value;
  const userId = auth.user?.id;
  const seed = text.trim();
  if (!s || !userId || !seed) return;
  if (!projects.byId.has(s.projectId)) {
    store.notify(t('chat.notCloudTask'), 'error');
    return;
  }
  const card = await board.createTask(
    taskInsertFromDraft(
      { name: taskNameFromText(seed), task: seed, model: s.model, prefix: 'feature', worktree: true, hidden: false, deepAnalysis: false, autoRun: false },
      s.projectId,
      userId,
    ),
  );
  if (!card) return;
  store.notify(t('research.filed', { title: card.title }), 'info', 6000, {
    label: t('research.openBacklog'),
    run: () => {
      overlay.close();
      store.selectProject(s.projectId);
      store.setBucket('tasks');
      void router.push({ name: 'agents' });
    },
  });
});

// ── The panel's own controls ────────────────────────────────────────────
const blocks = computed(() => (session.value ? buildChatBlocks(store.transcripts[session.value.id] ?? []) : []));
const voicePanel = useVoicePanel(() => session.value, { live: true, composer: () => panelEl.value?.dictationHost });

function nextMode(s: Session): MessageMode {
  return modeFor(s, store.transcripts[s.id] ?? []);
}

async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
    if (research.selectedId === s.id) panelEl.value?.restoreDraft(text, images);
  }
}

// ■ (and Esc from the window, AssistantLauncher.vue): the session stays pending until the store
// reports the turn over.
const { run: runStop, busy: stopping } = useAsyncAction(async (id: string) => {
  await store.stopSession(id);
  pending.mark('session:' + id, () => {
    const x = store.sessions.find((y) => y.id === id);
    return !x || (x.status !== 'thinking' && x.status !== 'tool');
  });
});
function onStop(): void {
  const s = session.value;
  if (s && !sessionPending.value) void runStop(s.id);
}

const { run: runAnswer, busy: answering } = useAsyncAction((id: string, res: RpcExtensionUIResponse) => store.answerUi(id, res));
function onAnswer(res: RpcExtensionUIResponse): void {
  if (session.value) void runAnswer(session.value.id, res);
}

const { run: runRestart, busy: restarting } = useAsyncAction(async (s: Session) => {
  const { id, status, lastActivityAt } = s;
  await store.restartSession(id);
  pending.mark('session:' + id, () => {
    const x = store.sessions.find((y) => y.id === id);
    return !x || x.status !== status || x.lastActivityAt !== lastActivityAt;
  });
});
function onRestart(): void {
  if (session.value && !sessionPending.value) void runRestart(session.value);
}

// Composer ↻ — wake a research the api has reaped, without sending anything.
async function onRefresh(): Promise<void> {
  const s = session.value;
  if (!s || refreshing.value) return;
  refreshing.value = true;
  try {
    await store.resumeSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    refreshing.value = false;
  }
}

const { run: runSummary, busy: summarizing } = useAsyncAction(async (s: Session) => {
  await store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s));
});
function onSummary(): void {
  if (session.value) void runSummary(session.value);
}

const effortPick = useOptimisticValue<ThinkingLevel | undefined>(
  () => session.value?.effort,
  async (level) => {
    if (session.value && level) await store.setEffort(session.value.id, level);
  },
);
let pickedProvider: string | undefined;
const modelPick = useOptimisticValue<string | undefined>(
  () => session.value?.model,
  async (model) => {
    const s = session.value;
    if (!s || !model) return;
    await store.setSessionModel(s.id, pickedProvider ? { model, provider: pickedProvider } : { model });
  },
);
function onSetModel(patch: { model: string; provider?: string }): void {
  pickedProvider = patch.provider;
  void modelPick.set(patch.model);
}

// The window hands the keyboard to the composer on opening and on expanding this panel.
function focus(): void {
  (panelEl.value?.$el as HTMLElement | undefined)?.querySelector('textarea')?.focus();
}
// Esc from the window stops a running turn of the open research first.
function stopTurn(): boolean {
  const s = session.value;
  if (!s || (s.status !== 'thinking' && s.status !== 'tool')) return false;
  onStop();
  return true;
}
defineExpose({ focus, stopTurn });
</script>

<style scoped lang="scss">
.rs {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.rs--folded {
  flex: none;
}

// The window's dense glass — ЦУК's recipe, so the panels read as one accordion.
.rs__box {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-bottom: var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  overflow: hidden;
}

.rs--folded .rs__box {
  flex: none;
}

.rs__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-2) var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.rs--folded .rs__head {
  border-bottom: none;
}

.rs__toggle {
  flex: 1;
  min-width: 0;
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;

  &:hover .rs__caret {
    color: var(--k-text);
  }
}

.rs__caret {
  flex: none;
  width: 6px;
  height: 10px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  color: var(--k-muted);
  transition: transform 0.15s ease, color 0.12s;
}

.rs__caret--open {
  transform: rotate(90deg);
}

.rs__title {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.rs__busy {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: rs-pulse 1.4s ease-in-out infinite;
}

.rs__history-btn,
.rs__findings {
  flex: none;
  height: 28px;
  padding: 0 var(--k-sp-2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: transparent;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover:not(:disabled),
  &[aria-expanded='true'],
  &[aria-pressed='true'] {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}

.rs__count {
  color: var(--k-faint);
}

.rs__main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rs__bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  min-height: 44px;
  padding: 0 var(--k-sp-2) 0 var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.rs__id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.rs__name,
.rs__rename {
  min-width: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.rs__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs__rename {
  flex: 0 1 auto;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--k-accent);
  padding: 0;
  outline: none;
}

.rs__project {
  flex: none;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rs__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

// The one destructive control of the bar spins into danger-red, as on the agent bar.
.rs__actions .rs__close {
  transition: border-color 0.14s, color 0.14s, transform 0.2s ease;

  &:hover:not(:disabled) {
    transform: rotate(90deg);
    border-color: var(--k-danger);
    color: var(--k-danger);
  }
}

.rs__note {
  flex: none;
  margin: 0;
  padding: 5px var(--k-sp-3) 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

// Bare, so it flows flat on the glass with no box of its own; `min-height: 0` lets its log scroll.
.rs__panel {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}

.rs__findings-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--k-sp-4) var(--k-sp-3);
}

.rs__skeleton,
.rs__wait {
  padding: var(--k-sp-3);
}

.rs__wait {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

// An empty research says what it is for, as ЦУК's greeting does.
.rs__hello {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  max-width: 560px;
  padding: var(--k-sp-4);
}

.rs__hello-text {
  margin: 0;
  font-size: var(--k-fs-md);
  line-height: 1.55;
  color: var(--k-text);
}

.rs__hello-note {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}

.rs__blank {
  margin: auto;
  max-width: 52ch;
  padding: var(--k-sp-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--k-sp-3);
}

.rs__blank-text {
  margin: 0;
  text-align: center;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-faint);
  overflow-wrap: anywhere;
}

// The history: teleported, above the window (5000) and dialogs (6000), like the kit's menus.
.rs__menu {
  position: fixed;
  z-index: 6500;
  width: 340px;
  overflow-y: auto;
  padding: var(--k-sp-1);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
}

.rs__row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  padding-right: var(--k-sp-1);
  border-radius: var(--k-r-sm);

  &:hover,
  &:focus-within {
    background: var(--k-surface2);
  }
}

.rs__row--on .rs__row-title {
  color: var(--k-accent);
}

.rs__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 6px var(--k-sp-2);
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: none;
  }
}

.rs__row-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rs__row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.rs__row-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

@keyframes rs-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rs__busy {
    animation: none;
  }
}
</style>
