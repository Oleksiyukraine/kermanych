<template>
  <main class="syn">
    <!-- No project bound → nothing to prototype in yet. -->
    <div v-if="!store.selectedProjectId" class="syn__blank mono">
      {{ t('synergy.page.blank') }}
    </div>

    <!-- Three columns, each an existing surface: the rail of sessions, the
         session browser over the branch preview with the step strip, and the Лог. -->
    <div
      v-else
      ref="contentEl"
      class="syn__content"
      :class="{ 'syn__content--resizing': railResizing || logResizing }"
    >
      <!-- RAIL — this project's Синергія sessions, newest first, archived ones hidden. -->
      <section class="syn__rail" :style="{ width: railWidth + 'px' }">
        <header class="syn__rail-head">
          <div class="syn__rail-title">
            <span class="syn__rail-label">{{ t('synergy.page.railTitle') }}</span>
            <span v-if="loadPhase === 'ready'" class="syn__rail-count mono">{{ sessions.length }}</span>
          </div>
          <div class="syn__rail-actions">
            <KBtn variant="primary" :disabled="!canStart" @click="openNew('feature')">{{ t('synergy.page.newFeature') }}</KBtn>
            <KBtn :disabled="!canStart" @click="openNew('page')">{{ t('synergy.page.changePage') }}</KBtn>
          </div>
          <p v-if="!canStart" class="syn__rail-note mono">{{ t('synergy.page.startUnavailable') }}</p>
        </header>

        <!-- The socket snapshot has not arrived: a skeleton, never «Ще немає сесій». -->
        <KSkeleton v-if="loadPhase === 'skeleton'" variant="rows" :rows="3" />
        <template v-else-if="loadPhase === 'ready'">
          <div v-if="sessions.length" class="syn__list">
            <KSessionCard
              v-for="s in sessions"
              :key="s.id"
              :branch="s.branch"
              :title="s.name"
              :time="renderTime(t, relativeTime(s.lastActivityAt, now))"
              :status="s.status"
              :model="s.model"
              :harness="sessionLaunchMode(s)"
              :usage="s.usage"
              :selected="s.id === sessionId"
              :pending="pending.isPending('session:' + s.id)"
              @click="select(s.id)"
            />
          </div>
          <p v-else class="syn__rail-empty mono">{{ t('synergy.page.railEmpty') }}</p>
        </template>
      </section>

      <div
        class="syn__resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('synergy.page.railResizeAria')"
        :aria-valuenow="Math.round(railWidth)"
        :aria-valuemin="MIN_RAIL"
        tabindex="0"
        v-tip="t('synergy.page.resizeTip')"
        @pointerdown="startRailResize"
        @keydown="onRailResizeKeydown"
      ></div>

      <template v-if="session">
        <!-- STAGE — identity and actions, the step strip, the canvas. -->
        <section class="syn__stage">
          <div class="syn__bar">
            <div class="syn__id">
              <KStatusDot :status="session.status" />
              <span class="syn__name">{{ session.name }}</span>
              <KTag v-if="session.branch" class="syn__branch">⑂ {{ session.branch }}</KTag>
            </div>
            <div class="syn__actions">
              <KBtn
                v-if="live"
                variant="primary"
                :loading="implementAction.busy.value"
                :disabled="!canImplement || sessionPending || discardAction.busy.value"
                :title="implementTip"
                @click="onImplement"
              >{{ t('synergy.page.implement') }}</KBtn>
              <KBtn
                v-if="live"
                variant="secondary"
                :disabled="!canImplement || sessionPending || implementAction.busy.value || discardAction.busy.value"
                :title="handoffTip"
                @click="handoffOpen = true"
              >{{ t('synergy.page.handoff') }}</KBtn>
              <KBtn
                variant="ghost"
                :loading="discardAction.busy.value"
                :disabled="sessionPending || implementAction.busy.value"
                :title="t('synergy.page.discardTip')"
                @click="onDiscard"
              >{{ t('synergy.page.discard') }}</KBtn>
            </div>
          </div>

          <!-- STEPS — step 0 «Початок», then one per checkpoint, oldest first; the last is the
               tree at HEAD (decision 4 of docs/specs/2026-11-06-synergy.md). -->
          <nav class="syn__strip" :aria-label="t('synergy.strip.aria')">
            <KSkeleton v-if="stepsPhase === 'skeleton'" variant="line" width="60%" />
            <p v-else-if="stepsError" class="syn__strip-note" role="alert">{{ t('synergy.strip.loadFailed', { error: stepsError }) }}</p>
            <ol v-else-if="stepsPhase === 'ready' && view" ref="stripEl" class="syn__steps">
              <li
                v-for="item in stripItems"
                :key="item.sha"
                class="syn__step"
                :class="{ 'syn__step--current': item.current, 'syn__step--restore': item.kind === 'restore' }"
                :aria-current="item.current ? 'step' : undefined"
              >
                <div class="syn__step-head">
                  <span class="syn__step-n mono">{{ item.n }}</span>
                  <span v-if="item.kind === 'restore'" class="syn__step-mark" aria-hidden="true">↺</span>
                  <span class="syn__step-text" :title="item.full">{{ item.label }}</span>
                </div>
                <div class="syn__step-foot">
                  <span v-if="item.at" class="syn__step-time mono">{{ renderTime(t, relativeTime(item.at, now)) }}</span>
                  <span v-if="item.current" class="syn__step-now mono">{{ t('synergy.strip.current') }}</span>
                  <KBtn
                    v-else-if="live"
                    variant="ghost"
                    class="syn__step-back"
                    :loading="restoreAction.busyFor(item.sha)"
                    :disabled="running || restoreAction.anyBusy() || implementAction.busy.value"
                    :title="running ? t('synergy.page.busyTip') : t('synergy.strip.restoreTip')"
                    @click="restoreAction.run(item.sha, session, item.n)"
                  >{{ t('synergy.strip.restore') }}</KBtn>
                </div>
              </li>
              <li v-if="!view.steps.length" class="syn__strip-empty mono">{{ t('synergy.strip.empty') }}</li>
            </ol>
          </nav>

          <!-- CANVAS — the session browser over the branch preview, or why there is none. -->
          <div class="syn__canvas">
            <p v-if="!sessionBrowser.available" class="syn__canvas-note">{{ t('synergy.stage.desktopOnly') }}</p>
            <p v-else-if="!isBound" class="syn__canvas-note">{{ t('agents.hints.bind') }}</p>
            <p v-else-if="retired" class="syn__canvas-note">{{ t('synergy.stage.retired') }}</p>
            <p v-else-if="!browserOk" class="syn__canvas-note">{{ t('synergy.stage.noBrowser') }}</p>
            <!-- Mounted only while the session is open here: the pane parks the native view when
                 it unmounts. Its preview row says when the branch has no valid preview config. -->
            <KBrowserPane
              v-else
              :key="session.id"
              :session="session"
              :sending="sendingPicks"
              :hold="railResizing || logResizing"
              :splittable="false"
              @send="sendPicks(session)"
            />
          </div>
        </section>

        <div
          class="syn__resizer"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('synergy.page.logResizeAria')"
          :aria-valuenow="Math.round(logWidth)"
          :aria-valuemin="MIN_LOG"
          tabindex="0"
          v-tip="t('synergy.page.resizeTip')"
          @pointerdown="startLogResize"
          @keydown="onLogResizeKeydown"
        ></div>

        <!-- LOG — the agent's transcript and composer with the voice conversation, as on «Агенти».
             Every message here — typed, «Надіслати агенту» or said — carries the page and the
             picks (decision 8; stores/orchestrator.ts sendMessage). -->
        <aside class="syn__log" :style="{ width: logWidth + 'px' }">
          <KTabs v-model="logTab" :tabs="logTabs" class="syn__log-tabs">
            <template #end>
              <button type="button" class="syn__log-ctl" @click="onExpandAll(true)">{{ t('agents.detail.expandAll') }}</button>
              <button type="button" class="syn__log-ctl" @click="onExpandAll(false)">{{ t('agents.detail.collapseAll') }}</button>
            </template>
          </KTabs>
          <KPanel
            ref="panelEl"
            class="syn__panel"
            :bare="true"
            :session="session"
            :refreshing="refreshingId === session.id"
            :stopping="stopping"
            :restarting="restarting || sessionPending"
            :summarizing="summarizing"
            :opening-editor="openingEditor"
            :pending="sessionPending"
            :answering="answering"
            :outgoing="store.outgoing[session.id] ?? []"
            :model-override="modelPick.value.value"
            :effort-override="effortPick.value.value"
            :model-loading="modelPick.pending.value"
            :effort-loading="effortPick.pending.value"
            :composer-disabled="logPhase !== 'ready'"
            :models="store.models"
            :placeholder="t('synergy.page.placeholder')"
            @stop="onStop"
            @send="onSend"
            @answer="onAnswer"
            @editor="onEditor"
            @restart="onRestart"
            @refresh="onRefresh"
            @summary="onSummary"
            @newTask="onNewTask"
            @expand-all="onExpandAll"
            @effort="effortPick.set"
            @set-model="onSetModel"
            :voiceable="true"
            :voice="voicePanel.bar.value"
            @voice-start="voicePanel.start"
            @voice-mute="voicePanel.mute"
            @voice-end="voicePanel.end"
          >
            <!-- Not loaded yet ≠ empty: «Журнал порожній» only once the transcript answered. -->
            <KSkeleton v-if="logPhase === 'skeleton'" variant="lines" :rows="6" />
            <template v-else-if="logPhase === 'ready'">
              <template v-if="blocks.length">
                <KRequestBlock
                  v-for="(block, i) in blocks"
                  :key="session.id + ':' + block.id"
                  :block="block"
                  :session-id="session.id"
                  :open="i === blocks.length - 1"
                  :expand-all="expandAll"
                />
              </template>
              <div v-else class="syn__log-empty mono">{{ t('agents.detail.logEmpty') }}</div>
            </template>
          </KPanel>
        </aside>
      </template>
      <!-- A session named by the URL or the last visit, before the snapshot shows it. -->
      <div v-else-if="sessionId && loadPhase === 'skeleton'" class="syn__detail-skeleton">
        <KSkeleton variant="line" width="40%" />
        <KSkeleton variant="rows" :rows="5" />
      </div>
      <div v-else-if="loadPhase === 'ready'" class="syn__detail-blank mono">{{ t('synergy.page.detailBlank') }}</div>
    </div>

    <!-- «+ Нова фіча» / «+ Змінити сторінку» (decision 5) — a short write (the launch), so the
         modal stays open and persistent with «Почати» spinning, and a failure shows inside it.
         The preview that follows is long and shows on the canvas instead. -->
    <KModal
      v-model="newOpen"
      :title="newMode === 'page' ? t('synergy.new.pageTitle') : t('synergy.new.featureTitle')"
      width="560px"
      :persistent="creating"
    >
      <div class="syn__form" :inert="creating">
        <KField
          v-if="newMode === 'feature'"
          ref="firstField"
          v-model="newTopic"
          :label="`${t('synergy.new.topic')} · ${t('synergy.new.optional')}`"
          :placeholder="t('synergy.new.topicPlaceholder')"
          @keydown.enter.prevent="createAction.run()"
        />
        <div v-else>
          <KField
            ref="firstField"
            v-model="newPage"
            :label="t('synergy.new.page')"
            :placeholder="t('synergy.new.pagePlaceholder')"
            @keydown.enter.prevent="createAction.run()"
          />
          <p class="syn__form-hint mono">{{ t('synergy.new.pageHint') }}</p>
        </div>
        <!-- `searchable`, as in the launcher: a long-lived repo has hundreds of branches. -->
        <KSelect
          v-model="newBase"
          :label="`${t('synergy.new.base')} · ${t('synergy.new.optional')}`"
          :options="newBranches"
          :loading="newBranchesLoading"
          searchable
        />
        <div class="syn__form-row">
          <KSelect
            v-model="newModel"
            class="syn__form-cell"
            :label="t('synergy.new.model')"
            :options="modelPickOptions"
            :placeholder="t('agents.launcher.defaultOption')"
            searchable
          />
          <KSelect
            v-model="newEffort"
            class="syn__form-cell"
            :label="t('synergy.new.effort')"
            :options="effortPickOptions"
            :placeholder="t('agents.launcher.defaultOption')"
          />
        </div>
        <p class="syn__form-hint mono">{{ t('synergy.new.hint') }}</p>
        <p v-if="newError" class="syn__error" role="alert">{{ newError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" :disabled="creating" @click="newOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
        <KBtn
          variant="primary"
          :loading="creating"
          :disabled="newMode === 'page' && !newPage.trim()"
          @click="createAction.run()"
        >{{ t('synergy.new.start') }}</KBtn>
      </template>
    </KModal>

    <!-- «Задача →» (docs/specs/2026-11-09-merge-design-into-synergy.md): the prototype as a card for
         later or for a teammate; its own dialog runs the push, the card and the close. -->
    <SynergyTaskDialog
      v-if="session && view"
      v-model="handoffOpen"
      :session="session"
      :brief="synergyBrief({ startPage: session.synergy?.page, requests: chronology })"
      :base="view.base"
      @handed-over="onHandedOver"
    />
  </main>
</template>

<script setup lang="ts">
// Синергія (docs/specs/2026-11-06-synergy.md): the operator builds a feature by talking to the
// running app — by text, by voice and with the ◎ pointer — and sees each change in seconds. A
// Синергія session is an ordinary `kind: 'agent'` session stamped with `synergy`, on its own
// `synergy/<slug>` worktree, run by a fast model with a narrow toolset; this page is its only
// view (Агенти hides it): the rail, the session browser over the branch preview (started by
// itself), the Лог with voice; the step strip — Kermanych commits a checkpoint after every turn,
// and «Повернутися сюди» restores one with a new commit — and the toolbar's «Імплементувати» (a
// card + a fresh agent on the brief), «Задача →» (the pushed branch as a card for later, the
// session closed; docs/specs/2026-11-09-merge-design-into-synergy.md) and «Відкинути».
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  SYNERGY_DEFAULT_EFFORT,
  SYNERGY_DEFAULT_MODEL,
  THINKING_LEVELS,
  buildChatBlocks,
  platformHasBrowser,
  synergyBrief,
  synergyChronology,
  taskNameFromText,
} from '@kermanych/core';
import type { ImageInput, Project, RpcExtensionUIResponse, Session, SynergyStepsView, ThinkingLevel } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { usePending } from 'stores/pending';
import { useSessionBrowser } from 'stores/browser';
import type { MessageMode } from '../lib/api';
import { taskInsertFromDraft } from '../lib/tasks-view';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import { relativeTime, renderTime } from '../lib/time';
import { sessionLaunchMode } from '../lib/native-session';
import { historyLoadFor } from '../lib/open-session-history';
import { confirmAction } from '../lib/confirm';
import { EFFORT_OPTIONS } from '../lib/effort';
import { effortOptions, modelOptions } from '../lib/models';
import { useNow } from '../composables/useNow';
import { useMarkSeen } from '../composables/useMarkSeen';
import { useResizablePanel } from '../composables/useResizablePanel';
import { errorText, useAsyncAction, useKeyedAction } from '../composables/useAsyncAction';
import { useVoicePanel } from '../composables/useVoicePanel';
import { nextMode as modeFor } from '../lib/message-mode';
import { useOptimisticValue } from '../composables/useOptimisticValue';
import { useLoadPhase } from '../composables/useLoadPhase';
import { useSendPicks } from '../composables/useSendPicks';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTabs from 'components/kit/KTabs.vue';
import KTag from 'components/kit/KTag.vue';
import KModal from 'components/kit/KModal.vue';
import SynergyTaskDialog from 'components/synergy/SynergyTaskDialog.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KBrowserPane from 'components/kit/KBrowserPane.vue';

const store = useOrchestrator();
const board = useBoard();
const auth = useAuth();
const projects = useProjects();
const pending = usePending();
const sessionBrowser = useSessionBrowser();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const now = useNow();

const selectedProject = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const isBound = computed(() => !!selectedProject.value?.localRepoPath);
// Desktop app and a project whose platform has a browser only (decision 9): the change is seen
// in the session browser, so without one a new session has nothing to show.
const browserOk = computed(() => platformHasBrowser(selectedProject.value?.platform));
const canStart = computed(() => sessionBrowser.available && browserOk.value);

// ── Rail ────────────────────────────────────────────────────────────────────
// This project's Синергія sessions, newest first, archived ones hidden.
const sessions = computed(() =>
  store.sessions
    .filter((s) => s.kind === 'agent' && !!s.synergy && s.projectId === store.selectedProjectId && !s.archived)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
);
// Until the socket's first snapshot an empty list means «not loaded», not «no sessions».
const loadPhase = useLoadPhase(() => !store.snapshotReceived);

// ── Selection ───────────────────────────────────────────────────────────────
// The open session lives in the URL (`?session=`, which MainLayout's redirect
// and «Карта агентів» use) and, per project, on this machine.
const SELECTED_KEY = 'kermanych.synergy.selected';
function readRemembered(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function remember(projectId: string, id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, JSON.stringify({ ...readRemembered(), [projectId]: id }));
  } catch {
    /* storage unavailable: the selection just is not restored */
  }
}
function initialSession(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  const fromUrl = route.query.session;
  if (typeof fromUrl === 'string' && fromUrl) {
    const s = store.sessions.find((x) => x.id === fromUrl);
    if (!s || s.projectId === projectId) return fromUrl;
  }
  return readRemembered()[projectId];
}

const sessionId = ref<string | undefined>(initialSession(store.selectedProjectId));
const session = computed(() => sessions.value.find((s) => s.id === sessionId.value));
const voicePanel = useVoicePanel(() => session.value);
useMarkSeen(() => session.value);

function select(id: string): void {
  sessionId.value = id;
  if (store.selectedProjectId) remember(store.selectedProjectId, id);
  if (route.query.session !== id) void router.replace({ query: { ...route.query, session: id } });
}

// A link into a session of another project switches the project first; the project watcher
// then opens the session the URL names.
watch(
  () => route.query.session,
  (id) => {
    if (typeof id !== 'string' || !id || id === sessionId.value) return;
    const s = store.sessions.find((x) => x.id === id);
    if (s && s.projectId !== store.selectedProjectId) store.selectProject(s.projectId);
    else sessionId.value = id;
  },
);
watch(
  () => store.selectedProjectId,
  (pid) => {
    sessionId.value = initialSession(pid);
    void nextTick(refreshRailWidth);
  },
);

const sessionPending = computed(() => !!session.value && pending.isPending('session:' + session.value.id));
const running = computed(() => session.value?.status === 'thinking' || session.value?.status === 'tool');
const retired = computed(
  () => !!session.value && (session.value.status === 'merged' || (session.value.worktree && !session.value.worktreePath)),
);
const live = computed(() => !!session.value && !retired.value && !session.value.archived);

// ── Log ─────────────────────────────────────────────────────────────────────
// The Агенти rule (lib/open-session-history.ts): the first open brings the
// transcript back, resuming the child when that is what it takes.
const transcriptFailed = ref<string | null>(null);
const refreshingId = ref<string | null>(null);
const logPhase = useLoadPhase(
  () => !!session.value && store.transcripts[session.value.id] === undefined && transcriptFailed.value !== session.value.id,
);
function loadTranscriptOf(id: string): void {
  void store.loadTranscript(id).catch((e: unknown) => {
    store.notify(errorText(e), 'error');
    if (store.transcripts[id] === undefined) transcriptFailed.value = id;
  });
}
function openHistory(s: Session): void {
  transcriptFailed.value = null;
  if (store.transcripts[s.id] !== undefined) return;
  if (historyLoadFor(s) === 'load') {
    loadTranscriptOf(s.id);
    return;
  }
  refreshingId.value = s.id;
  void store
    .resumeSession(s.id)
    .catch((e: unknown) => {
      store.notify(errorText(e), 'error');
      loadTranscriptOf(s.id);
    })
    .finally(() => {
      if (refreshingId.value === s.id) refreshingId.value = null;
    });
}

const blocks = computed(() => (session.value ? buildChatBlocks(store.transcripts[session.value.id] ?? []) : []));
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);
function onExpandAll(on: boolean): void {
  expandAll.value = nextExpandAll(expandAll.value, on);
}
const logTab = ref('log');
const logTabs = computed(() => [{ value: 'log', label: t('agents.tabs.log') }]);

const panelEl = ref<(ComponentPublicInstance & { restoreDraft: (text: string, images: readonly ImageInput[]) => void }) | null>(null);

function nextMode(s: Session): MessageMode {
  return modeFor(s, store.transcripts[s.id] ?? []);
}

// The store's sendMessage adds the page and the picks (decision 8); a failed send puts the
// operator's own text back in the composer, and the tray stays.
async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    store.notify(errorText(e), 'error');
    if (sessionId.value === s.id) panelEl.value?.restoreDraft(text, images);
  }
}

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

const { run: runAnswer, busy: answering } = useAsyncAction((id: string, res: RpcExtensionUIResponse) =>
  store.answerUi(id, res),
);
function onAnswer(res: RpcExtensionUIResponse): void {
  const s = session.value;
  if (s) void runAnswer(s.id, res);
}

const { run: runEditor, busy: openingEditor } = useAsyncAction((id: string) => store.openEditor(id));
function onEditor(): void {
  const s = session.value;
  if (s) void runEditor(s.id);
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
  const s = session.value;
  if (s && !sessionPending.value) void runRestart(s);
}

async function onRefresh(): Promise<void> {
  const s = session.value;
  if (!s || refreshingId.value) return;
  refreshingId.value = s.id;
  try {
    await store.resumeSession(s.id);
  } catch (e) {
    store.notify(errorText(e), 'error');
  } finally {
    refreshingId.value = null;
  }
}

const { run: runSummary, busy: summarizing } = useAsyncAction(async (s: Session) => {
  await store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s));
});
function onSummary(): void {
  const s = session.value;
  if (s) void runSummary(s);
}

// The composer's model and effort chips: Синергія's model can be switched live (decision 3).
const effortPick = useOptimisticValue<ThinkingLevel | undefined>(
  () => session.value?.effort,
  async (level) => {
    const s = session.value;
    if (s && level) await store.setEffort(s.id, level);
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

// A text selection in the log → a backlog card, the Чат path.
const { run: onNewTask } = useAsyncAction(async (text: string) => {
  const s = session.value;
  const userId = auth.user?.id;
  const seed = text.trim();
  if (!s || !userId || !seed) return;
  if (!projects.byId.has(s.projectId)) {
    store.notify(t('chat.page.notifyNotCloudTask'), 'error');
    return;
  }
  const card = await board.createTask(
    taskInsertFromDraft(
      {
        name: taskNameFromText(seed),
        task: seed,
        model: s.model,
        prefix: 'feature',
        worktree: true,
        hidden: false,
        deepAnalysis: false,
        autoRun: false,
      },
      s.projectId,
      userId,
    ),
  );
  if (!card) return;
  store.setBucket('tasks');
  void router.push({ name: 'agents' });
});

// ── Canvas ──────────────────────────────────────────────────────────────────
// Opening a session starts its preview. The launch already started
// it on the start path; this covers a reopened session after an api restart or an idle stop.
const previewStart = useKeyedAction(async (id: string) => {
  const info = await store.previewInfo(id);
  if (info.config.kind !== 'ok') return;
  const phase = info.state?.phase;
  if (phase === 'starting' || phase === 'running') return;
  await store.startPreview(id);
});
async function ensurePreview(s: Session): Promise<void> {
  if (!sessionBrowser.available || !isBound.value || retired.value || s.archived || !browserOk.value) return;
  await sessionBrowser.refresh(s.id).catch(() => undefined);
  if (sessionId.value !== s.id || sessionBrowser.states[s.id] || previewStart.busyFor(s.id)) return;
  void previewStart.run(s.id);
}

// Браузер → «Надіслати агенту»: for a Синергія session the tray goes through sendMessage's
// decoration (composables/useSendPicks.ts).
const { send: sendPicks, sending: sendingPicks } = useSendPicks({ mode: nextMode });

// ── Steps ───────────────────────────────────────────────────────────────────
// Read from git by the api (`GET /sessions/:id/synergy/steps`) when a session opens, whenever
// the api says a checkpoint or a restore landed (`synergy_steps`), and when a turn ends (a
// missed event over a reconnect costs no more than that). Only the latest read per session wins.
const stepsById = ref<Record<string, SynergyStepsView>>({});
const stepsFailed = ref<Record<string, string>>({});
const stepsGen = new Map<string, number>();
async function loadSteps(id: string): Promise<void> {
  const gen = (stepsGen.get(id) ?? 0) + 1;
  stepsGen.set(id, gen);
  try {
    const view = await store.synergySteps(id);
    if (stepsGen.get(id) !== gen) return;
    stepsById.value = { ...stepsById.value, [id]: view };
    if (id in stepsFailed.value) {
      const next = { ...stepsFailed.value };
      delete next[id];
      stepsFailed.value = next;
    }
  } catch (e) {
    if (stepsGen.get(id) !== gen) return;
    // A failure after a good read keeps the strip it has; only a first read shows the error.
    if (!stepsById.value[id]) stepsFailed.value = { ...stepsFailed.value, [id]: errorText(e) };
  }
}
const view = computed(() => (session.value ? stepsById.value[session.value.id] : undefined));
const stepsError = computed(() => (session.value && !view.value ? stepsFailed.value[session.value.id] : undefined));
const stepsPhase = useLoadPhase(() => !!session.value && !view.value && !stepsError.value);

type StripItem = { sha: string; n: number; kind: 'start' | 'change' | 'restore'; label: string; full: string; at?: string; current: boolean };
const stripItems = computed<StripItem[]>(() => {
  const v = view.value;
  const s = session.value;
  if (!v || !s) return [];
  // A restore names the step it brought back by its number, in the operator's language (its
  // commit subject is fixed Ukrainian).
  const numberOf = (sha: string | undefined): number | string => {
    if (!sha) return '?';
    if (sha === v.startSha) return 0;
    return v.steps.find((x) => x.sha === sha)?.n ?? '?';
  };
  const items: StripItem[] = [
    { sha: v.startSha, n: 0, kind: 'start', label: t('synergy.strip.start'), full: s.synergy?.page ?? v.base, at: s.createdAt, current: false },
    ...v.steps.map((step): StripItem => {
      const label = step.kind === 'restore' ? t('synergy.strip.restored', { n: numberOf(step.restoreOf) }) : step.request.split('\n')[0]!.trim();
      return { sha: step.sha, n: step.n, kind: step.kind, label, full: step.kind === 'restore' ? label : step.request, at: step.at, current: false };
    }),
  ];
  items[items.length - 1]!.current = true;
  return items;
});

// The newest step is the one that matters: keep the strip scrolled to it.
const stripEl = ref<HTMLElement | null>(null);
watch(
  () => stripItems.value.length,
  () =>
    void nextTick(() => {
      if (stripEl.value) stripEl.value.scrollLeft = stripEl.value.scrollWidth;
    }),
);

watch(
  () => (session.value ? store.synergyStepsRev[session.value.id] : undefined),
  (rev, before) => {
    if (session.value && rev !== before && rev !== undefined) void loadSteps(session.value.id);
  },
);
watch(running, (isRunning, wasRunning) => {
  if (wasRunning && !isRunning && session.value) void loadSteps(session.value.id);
});

// «Повернутися сюди» (decision 4): the api commits that step's tree on top and answers with the
// new strip; refused while a turn runs, so the button is off then too.
const restoreAction = useKeyedAction(async (sha: string, s: Session, n: number) => {
  const next = await store.restoreSynergy(s.id, sha);
  stepsById.value = { ...stepsById.value, [s.id]: next };
  store.notify(t('synergy.strip.notifyRestored', { n }), 'info');
});

// Everything a session needs when it comes on screen.
watch(
  () => session.value?.id,
  (id) => {
    expandAll.value = EXPAND_ALL_NONE;
    logTab.value = 'log';
    const s = session.value;
    if (!id || !s) return;
    openHistory(s);
    void loadSteps(s.id);
    void ensurePreview(s);
  },
  { immediate: true },
);

// ── «Імплементувати» ────────────────────────────────────────────────────────
// Decision 6: the UI files the card (title = the session name, description = the brief), then
// the api turns this session into an ordinary agent with a fresh child on the brief, in the same
// worktree. Offered once a change survives at HEAD; refused while a turn runs. A call that fails
// after the card exists retries on that card (refreshed with the current brief) rather than
// minting a second one.
const chronology = computed(() => (view.value ? synergyChronology(view.value.steps, view.value.startSha) : []));
const canImplement = computed(() => live.value && !running.value && chronology.value.length > 0);
const implementTip = computed(() =>
  running.value ? t('synergy.page.busyTip') : chronology.value.length ? t('synergy.page.implementTip') : t('synergy.page.implementEmptyTip'),
);
// «Задача →»: offered when «Імплементувати» is; the dialog says the rest.
const handoffOpen = ref(false);
const handoffTip = computed(() =>
  running.value ? t('synergy.page.busyTip') : chronology.value.length ? t('synergy.page.handoffTip') : t('synergy.page.implementEmptyTip'),
);
// The card exists and the delete is on its way: the row waits for `session_removed`, as «Відкинути».
function onHandedOver(s: Session): void {
  pending.mark('session:' + s.id, () => !store.sessions.some((x) => x.id === s.id));
}
const implementCards = new Map<string, string>();

const implementAction = useAsyncAction(async (s: Session, brief: string) => {
  const userId = auth.user?.id;
  if (!userId) throw new Error(t('agents.launcher.loginFirst'));
  if (projects.listRead && !projects.byId.has(s.projectId)) throw new Error(t('agents.hints.publishFirst'));
  let cardId = implementCards.get(s.id);
  if (cardId) {
    if (!(await board.updateTaskFields(cardId, { title: s.name, description: brief }))) return;
  } else {
    const project: Project | undefined = store.projects.find((p) => p.id === s.projectId);
    const card = await board.createTask({
      projectId: s.projectId,
      title: s.name,
      description: brief,
      prefix: 'feature',
      worktree: true,
      assigneeId: userId,
      ...(project?.defaultModel ? { model: project.defaultModel } : {}),
      ...(project?.defaultEffort ? { effort: project.defaultEffort } : {}),
    });
    if (!card) throw new Error(t('synergy.page.cardFailed'));
    cardId = card.id;
    implementCards.set(s.id, cardId);
  }
  const next = await store.implementSynergy(s.id, cardId);
  implementCards.delete(s.id);
  store.notify(t('synergy.page.notifyImplemented', { name: s.name }), 'info');
  // The row is already without `synergy` (stores/orchestrator.ts), so MainLayout's redirect
  // leaves the selection on «Агенти».
  store.setBucket('agents');
  store.selectSession(next.id);
  void router.push({ name: 'agents' });
});

async function onImplement(): Promise<void> {
  const s = session.value;
  if (!s || !canImplement.value) return;
  const brief = synergyBrief({ startPage: s.synergy?.page, requests: chronology.value });
  const ok = await confirmAction({
    title: t('synergy.confirm.implementTitle', { name: s.name }),
    message: t('synergy.confirm.implementMessage', { branch: s.branch ?? '' }),
    confirmLabel: t('synergy.page.implement'),
  });
  if (ok) await implementAction.run(s, brief);
}

// ── «Відкинути» ─────────────────────────────────────────────────────────────
// Decision 9: the existing delete — child, preview, worktree and the local branch go. The row
// stays pending until the api's `session_removed` takes it off the rail.
const discardAction = useAsyncAction(async (s: Session) => {
  await store.deleteSession(s.id);
  pending.mark('session:' + s.id, () => !store.sessions.some((x) => x.id === s.id));
});
async function onDiscard(): Promise<void> {
  const s = session.value;
  if (!s || sessionPending.value) return;
  const ok = await confirmAction({
    title: t('synergy.confirm.discardTitle', { name: s.name }),
    message: t('synergy.confirm.discardMessage', { branch: s.branch ?? '' }),
    confirmLabel: t('confirmations.label.discard'),
  });
  if (ok) await discardAction.run(s);
}

// ── «+ Нова фіча» / «+ Змінити сторінку» ────────────────────────────────────
// Decision 5: no card at launch (`POST /sessions/synergy`); the child starts idle and the
// preview opens on the start path. Decision 3: the model and effort the operator chose last time
// on this machine, else Sonnet at `low`; a model this machine's catalogue lacks falls back to
// the project default.
type NewMode = 'feature' | 'page';
const LAUNCH_KEY = 'kermanych.synergy.launch';
function readLaunchChoice(): { model?: string; effort?: string } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAUNCH_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as { model?: string; effort?: string }) : {};
  } catch {
    return {};
  }
}
function saveLaunchChoice(model: string, effort: string): void {
  try {
    localStorage.setItem(LAUNCH_KEY, JSON.stringify({ model, effort }));
  } catch {
    /* storage refused: the next form starts from the defaults */
  }
}
function initialModel(project: Project | undefined): string {
  const known = (id: string | undefined): id is string => !!id && store.models.some((m) => m.id === id);
  const remembered = readLaunchChoice().model;
  if (known(remembered)) return remembered;
  if (known(SYNERGY_DEFAULT_MODEL)) return SYNERGY_DEFAULT_MODEL;
  return project?.defaultModel ?? '';
}
function initialEffort(): ThinkingLevel {
  const remembered = readLaunchChoice().effort;
  return (THINKING_LEVELS as readonly string[]).includes(remembered ?? '') ? (remembered as ThinkingLevel) : SYNERGY_DEFAULT_EFFORT;
}

const newOpen = ref(false);
const newMode = ref<NewMode>('feature');
const newTopic = ref('');
const newPage = ref('');
const newBase = ref('');
const newModel = ref('');
const newEffort = ref<string>('');
const newBranches = ref<string[]>([]);
const newBranchesLoading = ref(false);
const newError = ref<string | null>(null);
const firstField = ref<InstanceType<typeof KField> | null>(null);
let branchesRun = 0;

const modelPickOptions = computed(() => modelOptions(store.models));
const effortPickOptions = computed(() => {
  const allowed = effortOptions(store.models, newModel.value || undefined);
  return EFFORT_OPTIONS.filter((o) => allowed.includes(o.value)).map((o) => ({ value: o.value, label: t(o.labelKey) }));
});

// The fork base: the project's default first, then every branch once the repo
// answers. A reopened modal drops an older reply.
async function loadBranches(projectId: string): Promise<void> {
  const run = ++branchesRun;
  newBranches.value = [];
  newBase.value = selectedProject.value?.defaultBranch ?? '';
  if (!isBound.value) return;
  newBranchesLoading.value = true;
  try {
    const info = await store.listBranches(projectId);
    if (run !== branchesRun) return;
    newBranches.value = info.branches;
    if (!newBase.value) newBase.value = info.default ?? info.current ?? '';
  } catch {
    // Non-fatal: the picker keeps the project default only.
  } finally {
    if (run === branchesRun) newBranchesLoading.value = false;
  }
}

function openNew(mode: NewMode): void {
  const pid = store.selectedProjectId;
  if (!pid || !canStart.value) return;
  newMode.value = mode;
  newTopic.value = '';
  newPage.value = '';
  newError.value = null;
  newModel.value = initialModel(selectedProject.value);
  newEffort.value = initialEffort();
  void loadBranches(pid);
  newOpen.value = true;
  void nextTick(() => firstField.value?.focus());
}

const createAction = useAsyncAction(createSynergy, {
  onError: (e) => {
    newError.value = errorText(e);
  },
});
const creating = computed(() => createAction.busy.value);

// A start path is a path in the app: typed without the leading slash it gets one. A pasted
// address goes as is; the api keeps its path, query and hash.
function startPath(raw: string): string {
  const path = raw.trim();
  return path.startsWith('/') || /^https?:\/\//i.test(path) ? path : `/${path}`;
}

async function createSynergy(): Promise<void> {
  const pid = store.selectedProjectId;
  if (!pid) return;
  const page = newMode.value === 'page' ? newPage.value.trim() : '';
  // Enter in «Сторінка» bypasses the disabled button.
  if (newMode.value === 'page' && !page) return;
  if (!isBound.value) {
    newError.value = t('agents.hints.bind');
    return;
  }
  newError.value = null;
  const topic = newMode.value === 'feature' ? newTopic.value.trim() : '';
  const base = newBase.value.trim();
  const model = newModel.value.trim();
  const effort = (THINKING_LEVELS as readonly string[]).includes(newEffort.value) ? (newEffort.value as ThinkingLevel) : undefined;
  const created = await store.createSynergy({
    projectId: pid,
    ...(topic ? { topic } : {}),
    ...(page ? { page: startPath(page) } : {}),
    ...(base ? { base } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  });
  saveLaunchChoice(model, effort ?? '');
  newOpen.value = false;
  if (store.selectedProjectId === pid) select(created.id);
}

// ── Layout ──────────────────────────────────────────────────────────────────
const MIN_RAIL = 220;
const MIN_LOG = 320;
const MIN_CANVAS = 360;
const contentEl = ref<HTMLElement | null>(null);
const {
  size: railWidth,
  resizing: railResizing,
  startResize: startRailResize,
  onKeydown: onRailResizeKeydown,
  refresh: refreshRailWidth,
} = useResizablePanel({
  storageKey: 'kermanych.synergy.rail-width',
  defaultSize: 240,
  min: MIN_RAIL,
  edge: 'right',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_CANVAS - (session.value ? logWidth.value : 0) : Number.POSITIVE_INFINITY,
});
const {
  size: logWidth,
  resizing: logResizing,
  startResize: startLogResize,
  onKeydown: onLogResizeKeydown,
  refresh: refreshLogWidth,
} = useResizablePanel({
  storageKey: 'kermanych.synergy.log-width',
  defaultSize: 340,
  min: MIN_LOG,
  edge: 'left',
  max: () => (contentEl.value ? contentEl.value.clientWidth - MIN_CANVAS - railWidth.value : Number.POSITIVE_INFINITY),
});

onMounted(() => {
  refreshRailWidth();
  refreshLogWidth();
});
</script>

<style scoped lang="scss">
// The page's geometry: rail, stage and log columns.
.syn {
  height: 100%;
  overflow: hidden;
  padding: var(--k-sp-3);
  display: flex;
  flex-direction: column;
}

.syn__content {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.syn__content--resizing,
.syn__content--resizing * {
  cursor: col-resize !important;
  user-select: none;
}

// ── Rail ──
.syn__rail {
  flex: none;
  min-width: 0;
  overflow-y: auto;
  padding: var(--k-sp-4);
}

.syn__rail-head {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin-bottom: var(--k-sp-3);
}

.syn__rail-title {
  display: flex;
  align-items: baseline;
}

.syn__rail-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.syn__rail-count {
  margin-left: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.syn__rail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

.syn__rail-note {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

.syn__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.syn__rail-empty {
  margin: 0;
  padding: 24px 2px;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// ── Seams ──
.syn__resizer {
  flex: none;
  width: 7px;
  position: relative;
  z-index: 3;
  cursor: col-resize;
  touch-action: none;
  user-select: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--k-line);
    transition: background 0.12s;
  }

  &:hover::before,
  &:focus-visible::before {
    background: var(--k-accent);
  }

  &:focus-visible {
    outline: none;
  }
}

.syn__content--resizing .syn__resizer::before {
  background: var(--k-accent);
}

// ── Stage ──
.syn__stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.syn__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 4px 8px 4px 12px;
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
  flex-wrap: wrap;
}

.syn__id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.syn__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.syn__branch {
  min-width: 0;
  overflow: hidden;
}

.syn__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

// ── Step strip: one row of cards, scrolled to the newest ──
.syn__strip {
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--k-line);
}

.syn__strip-note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

.syn__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.syn__step {
  flex: none;
  width: 200px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: transparent;
}

.syn__step--current {
  border-color: var(--k-accent);
}

// A restore is a step too, but not a change: dashed and in the muted ink.
.syn__step--restore {
  border-style: dashed;
  color: var(--k-muted);
}

.syn__step-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.syn__step-n {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.syn__step-mark {
  flex: none;
  font-size: var(--k-fs-xs);
}

.syn__step-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
}

.syn__step-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 24px;
}

.syn__step-time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.syn__step-now {
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.syn__step-back {
  margin-left: auto;
}

.syn__strip-empty {
  // Beside «Початок» the note takes the rest of the row and wraps: the row scrolls to its end
  // for the newest step, which would cut a single long line on the left.
  flex: 1 1 0;
  min-width: 0;
  align-self: center;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.syn__canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.syn__canvas-note {
  flex: 1;
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-faint);
}

// ── Log ──
.syn__log {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.syn__log-tabs {
  flex: none;
  padding: 0 12px;
}

.syn__log-ctl {
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover { color: var(--k-text); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
}

.syn__log .syn__panel {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}

.syn__log-empty {
  margin: auto;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.syn__detail-skeleton {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
}

.syn__detail-blank,
.syn__blank {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

// ── Start form ──
.syn__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.syn__form-row {
  display: flex;
  gap: 12px;
}

.syn__form-cell {
  flex: 1;
  min-width: 0;
}

.syn__form-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--k-muted);
}

.syn__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
