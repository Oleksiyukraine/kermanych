<template>
  <main class="design">
    <!-- No project bound → nothing to design in yet. -->
    <div v-if="!store.selectedProjectId" class="design__blank mono">
      {{ t('design.page.blank') }}
    </div>

    <!-- Three columns, each an existing surface: the Чат rail of sessions, the session browser
         the Агенти «Браузер» tab shows, and the Лог the Агенти detail runs `bare`. -->
    <div
      v-else
      ref="contentEl"
      class="design__content"
      :class="{ 'design__content--resizing': railResizing || logResizing }"
    >
      <!-- RAIL — this project's designs, newest first, archived ones hidden. -->
      <section class="design__rail" :style="{ width: railWidth + 'px' }">
        <header class="design__rail-head">
          <div class="design__rail-title">
            <span class="design__rail-label">{{ t('design.page.railTitle') }}</span>
            <span v-if="loadPhase === 'ready'" class="design__rail-count mono">{{ designs.length }}</span>
          </div>
          <KBtn variant="primary" @click="openNew">{{ t('design.page.newDesign') }}</KBtn>
        </header>

        <!-- The socket snapshot has not arrived: a skeleton, never «Ще немає дизайнів». -->
        <KSkeleton v-if="loadPhase === 'skeleton'" variant="rows" :rows="3" />
        <template v-else-if="loadPhase === 'ready'">
          <div v-if="designs.length" class="design__list">
            <KSessionCard
              v-for="s in designs"
              :key="s.id"
              :branch="s.branch"
              :title="s.name"
              :time="renderTime(t, relativeTime(s.lastActivityAt, now))"
              :status="s.status"
              :model="s.model"
              :harness="sessionLaunchMode(s)"
              :usage="s.usage"
              :selected="s.id === designId"
              :pending="pending.isPending('session:' + s.id)"
              @click="select(s.id)"
            />
          </div>
          <p v-else class="design__rail-empty mono">{{ t('design.page.railEmpty') }}</p>
        </template>
      </section>

      <div
        class="design__resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('design.page.railResizeAria')"
        :aria-valuenow="Math.round(railWidth)"
        :aria-valuemin="MIN_RAIL"
        tabindex="0"
        v-tip="t('design.page.resizeTip')"
        @pointerdown="startRailResize"
        @keydown="onRailResizeKeydown"
      ></div>

      <template v-if="design">
        <!-- STAGE — identity and the design's actions over the canvas. -->
        <section class="design__stage">
          <div class="design__bar">
            <div class="design__id">
              <KStatusDot :status="design.status" />
              <span class="design__name">{{ design.name }}</span>
              <KTag v-if="design.branch" class="design__branch">⑂ {{ design.branch }}</KTag>
            </div>
            <div class="design__actions">
              <template v-if="live">
                <KBtn
                  variant="primary"
                  :loading="saving"
                  :disabled="sessionPending"
                  :title="t('design.page.saveTip')"
                  @click="saveAction.run(design)"
                >{{ t('design.page.save') }}</KBtn>
                <KBtn
                  :loading="prAction.busy.value"
                  :disabled="sessionPending"
                  @click="prAction.run(design)"
                >{{ hasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }}</KBtn>
                <KBtn :disabled="sessionPending" @click="finishOpen = true">{{ t('agents.finish.action') }}</KBtn>
              </template>
              <KBtn
                v-if="hasReadme"
                variant="ghost"
                :title="t('design.page.toTaskTip')"
                @click="docTaskOpen = true"
              >{{ t('design.page.toTask') }}</KBtn>
            </div>
          </div>

          <!-- CANVAS — the session browser over the branch preview, or why there is none. -->
          <div class="design__canvas">
            <!-- The web build has no session browser: the saved folder instead of a canvas. -->
            <template v-if="!sessionBrowser.available">
              <p class="design__canvas-note design__canvas-note--bar">{{ t('design.canvas.desktopOnly') }}</p>
              <DesignFolder v-if="design.designDir && design.worktreePath" :session="{ ...design, designDir: design.designDir }" />
            </template>
            <p v-else-if="!isBound" class="design__canvas-note">{{ t('agents.hints.bind') }}</p>
            <p v-else-if="retired" class="design__canvas-note">{{ t('design.canvas.retired') }}</p>
            <div v-else-if="noCommand" class="design__canvas-note">
              <p class="design__canvas-text">{{ t('design.canvas.needsCommand') }}</p>
              <RouterLink class="design__canvas-link" :to="{ name: 'settings', params: { section: 'project-commands' } }">
                {{ t('design.canvas.needsCommandLink') }}
              </RouterLink>
            </div>
            <!-- Mounted only while a design is open here: the pane parks the native view when it
                 unmounts, so another design, a modal or leaving Дизайн hides the page. -->
            <KBrowserPane
              v-else
              :key="design.id"
              :session="design"
              :sending="sendingPicks"
              :starting="previewStart.busyFor(design.id)"
              :hold="railResizing || logResizing"
              :splittable="false"
              @send="sendPicks(design)"
            />
          </div>
        </section>

        <div
          class="design__resizer"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('design.page.logResizeAria')"
          :aria-valuenow="Math.round(logWidth)"
          :aria-valuemin="MIN_LOG"
          tabindex="0"
          v-tip="t('design.page.resizeTip')"
          @pointerdown="startLogResize"
          @keydown="onLogResizeKeydown"
        ></div>

        <!-- LOG — the Дизайнер's transcript and composer, the Агенти «Лог» tab as is. -->
        <aside class="design__log" :style="{ width: logWidth + 'px' }">
          <KTabs v-model="logTab" :tabs="logTabs" class="design__log-tabs">
            <template #end>
              <button type="button" class="design__log-ctl" @click="onExpandAll(true)">{{ t('agents.detail.expandAll') }}</button>
              <button type="button" class="design__log-ctl" @click="onExpandAll(false)">{{ t('agents.detail.collapseAll') }}</button>
            </template>
          </KTabs>
          <KPanel
            ref="panelEl"
            class="design__panel"
            :bare="true"
            :session="design"
            :refreshing="refreshingId === design.id"
            :stopping="stopping"
            :restarting="restarting || sessionPending"
            :summarizing="summarizing"
            :opening-editor="openingEditor"
            :pending="sessionPending"
            :answering="answering"
            :outgoing="store.outgoing[design.id] ?? []"
            :model-override="modelPick.value.value"
            :effort-override="effortPick.value.value"
            :model-loading="modelPick.pending.value"
            :effort-loading="effortPick.pending.value"
            :composer-disabled="logPhase !== 'ready'"
            :models="store.models"
            :placeholder="t('design.page.placeholder')"
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
          >
            <!-- Not loaded yet ≠ empty: «Журнал порожній» only once the transcript answered. -->
            <KSkeleton v-if="logPhase === 'skeleton'" variant="lines" :rows="6" />
            <template v-else-if="logPhase === 'ready'">
              <template v-if="blocks.length">
                <KRequestBlock
                  v-for="(block, i) in blocks"
                  :key="design.id + ':' + block.id"
                  :block="block"
                  :session-id="design.id"
                  :open="i === blocks.length - 1"
                  :expand-all="expandAll"
                />
              </template>
              <div v-else class="design__log-empty mono">{{ t('agents.detail.logEmpty') }}</div>
            </template>
          </KPanel>
        </aside>
      </template>
      <!-- A design named by the URL or the last visit, before the snapshot shows it. -->
      <div v-else-if="designId && loadPhase === 'skeleton'" class="design__detail-skeleton">
        <KSkeleton variant="line" width="40%" />
        <KSkeleton variant="rows" :rows="5" />
      </div>
      <div v-else-if="loadPhase === 'ready'" class="design__detail-blank mono">{{ t('design.page.detailBlank') }}</div>
    </div>

    <!-- «+ Новий дизайн» — a short write (the card, then the launch), so the modal stays open
         and persistent with «Створити» spinning, and a failure shows inside it. The preview that
         follows is long and shows on the canvas instead. -->
    <KModal v-model="newOpen" :title="t('design.new.title')" width="560px" :persistent="creating">
      <div class="design__form" :inert="creating">
        <KField
          ref="topicField"
          v-model="newTopic"
          :label="t('design.new.topic')"
          :placeholder="t('design.new.topicPlaceholder')"
          @keydown.enter.prevent="createAction.run()"
        />
        <KField
          v-model="newDescription"
          multiline
          :rows="5"
          :label="`${t('design.new.description')} · ${t('agents.launcher.optional')}`"
          :placeholder="t('design.new.descriptionPlaceholder')"
        />
        <!-- `searchable`, as in the launcher: a long-lived repo has hundreds of branches. -->
        <KSelect
          v-model="newBase"
          :label="`${t('design.new.base')} · ${t('agents.launcher.optional')}`"
          :options="newBranches"
          :loading="newBranchesLoading"
          searchable
        />
        <p v-if="newError" class="design__error" role="alert">{{ newError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" :disabled="creating" @click="newOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="creating" :disabled="!newTopic.trim()" @click="createAction.run()">
          {{ t('design.new.create') }}
        </KBtn>
      </template>
    </KModal>

    <FinishSheet v-model="finishOpen" :session="design ?? null" />
    <DocTaskDialog v-if="design?.designDir" v-model="docTaskOpen" :session="design" :path="designReadmePath(design.designDir)" />
  </main>
</template>

<script setup lang="ts">
// Дизайн (docs/specs/2026-10-29-design-tab.md): a «Дизайнер» agent builds a screen as a
// prototype on the project's own UI kit while the operator watches it in the session browser
// and points at it. A design is an ordinary `kind: 'agent'` session with a stamped `designDir`;
// this page is its only view (Агенти hides it, «Карта агентів» still shows it). Left: the
// project's designs. Centre: the canvas — the branch preview in the session browser, started by
// itself when a design opens. Right: the Дизайнер's log and composer. The toolbar carries
// «Зберегти дизайн» (screenshots + README + commit), «Створити ПР», «Завершити» and, once the
// README exists, «Задача →».
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { buildChatBlocks, designReadmePath, taskNameFromText } from '@kermanych/core';
import type { ImageInput, RpcExtensionUIResponse, Session, ThinkingLevel } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { usePending } from 'stores/pending';
import { useSessionBrowser } from 'stores/browser';
import { api, type MessageMode } from '../lib/api';
import { taskInsertFromDraft } from '../lib/tasks-view';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import { relativeTime, renderTime } from '../lib/time';
import { sessionLaunchMode } from '../lib/native-session';
import { historyLoadFor } from '../lib/open-session-history';
import { useNow } from '../composables/useNow';
import { useResizablePanel } from '../composables/useResizablePanel';
import { errorText, useAsyncAction, useKeyedAction } from '../composables/useAsyncAction';
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
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KBrowserPane from 'components/kit/KBrowserPane.vue';
import FinishSheet from 'components/agents/FinishSheet.vue';
import DocTaskDialog from 'components/docs/DocTaskDialog.vue';
import DesignFolder from 'components/design/DesignFolder.vue';

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

// ── Rail ────────────────────────────────────────────────────────────────────
// This project's designs, newest first (by launch: a design keeps its place while the agent
// works), archived ones hidden.
const designs = computed(() =>
  store.sessions
    .filter((s) => s.kind === 'agent' && !!s.designDir && s.projectId === store.selectedProjectId && !s.archived)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
);
// Until the socket's first snapshot an empty list means «not loaded», not «no designs».
const loadPhase = useLoadPhase(() => !store.snapshotReceived);

// ── Selection ───────────────────────────────────────────────────────────────
// The open design is this page's own, not the Агенти selection: it lives in the URL
// (`?session=`, which «Карта агентів» links to) and, per project, on this machine, so coming
// back to Дизайн reopens the design that was open.
const SELECTED_KEY = 'kermanych.design.selected';
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
function initialDesign(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  // The URL wins while it names a design of this project (or one the snapshot has not brought
  // yet); after a switch to another project it names the old one, and the memory answers.
  const fromUrl = route.query.session;
  if (typeof fromUrl === 'string' && fromUrl) {
    const s = store.sessions.find((x) => x.id === fromUrl);
    if (!s || s.projectId === projectId) return fromUrl;
  }
  return readRemembered()[projectId];
}

const designId = ref<string | undefined>(initialDesign(store.selectedProjectId));
const design = computed(() => designs.value.find((s) => s.id === designId.value));

function select(id: string): void {
  designId.value = id;
  if (store.selectedProjectId) remember(store.selectedProjectId, id);
  if (route.query.session !== id) void router.replace({ query: { ...route.query, session: id } });
}

// A link into a design of another project («Карта агентів») switches the project first; the
// project watcher below then opens the design the URL names.
watch(
  () => route.query.session,
  (id) => {
    if (typeof id !== 'string' || !id || id === designId.value) return;
    const s = store.sessions.find((x) => x.id === id);
    if (s && s.projectId !== store.selectedProjectId) store.selectProject(s.projectId);
    else designId.value = id;
  },
);
watch(
  () => store.selectedProjectId,
  (pid) => {
    designId.value = initialDesign(pid);
    void nextTick(refreshRailWidth);
  },
);

const sessionPending = computed(() => !!design.value && pending.isPending('session:' + design.value.id));
const running = computed(() => design.value?.status === 'thinking' || design.value?.status === 'tool');
// The worktree is gone (finished, or retired some other way): nothing to preview or save.
const retired = computed(
  () => !!design.value && (design.value.status === 'merged' || (design.value.worktree && !design.value.worktreePath)),
);
// A design whose branch can still take work — the save / PR / finish toolbar.
const live = computed(() => !!design.value && !retired.value && !design.value.archived);

// ── Log ─────────────────────────────────────────────────────────────────────
// Bring the transcript back the first time a design is opened, resuming it when that is what
// it takes — the Агенти rule (lib/open-session-history.ts): a plain load after a restart or an
// idle reap answers an empty log with nothing explaining why.
const transcriptFailed = ref<string | null>(null);
const refreshingId = ref<string | null>(null);
const logPhase = useLoadPhase(
  () => !!design.value && store.transcripts[design.value.id] === undefined && transcriptFailed.value !== design.value.id,
);
function loadTranscriptOf(id: string): void {
  void store.loadTranscript(id).catch((e: unknown) => {
    store.notify(errorText(e), 'error');
    // Ends the skeleton: the log falls back to its empty state rather than loading forever.
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

const blocks = computed(() => (design.value ? buildChatBlocks(store.transcripts[design.value.id] ?? []) : []));
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);
function onExpandAll(on: boolean): void {
  expandAll.value = nextExpandAll(expandAll.value, on);
}
// One tab, for the density switch's home: the same row the Агенти and Чат logs sit under.
const logTab = ref('log');
const logTabs = computed(() => [{ value: 'log', label: t('agents.tabs.log') }]);

const panelEl = ref<(ComponentPublicInstance & { restoreDraft: (text: string, images: readonly ImageInput[]) => void }) | null>(null);

// Which omp message mode the next message takes: a fresh session starts with a prompt, a
// settled one gets a follow-up, a live one is steered mid-turn — the Агенти and Чат rule.
function nextMode(s: Session): MessageMode {
  const history = store.transcripts[s.id] ?? [];
  const hasTurn = history.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !hasTurn ? 'prompt' : s.status === 'done' ? 'follow_up' : 'steer';
}

// The bubble («надсилаю…») is the store's; a failed send puts the text back in the composer.
async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = design.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    store.notify(errorText(e), 'error');
    if (designId.value === s.id) panelEl.value?.restoreDraft(text, images);
  }
}

// ■ — the session stays pending until the store reports it stopped.
const { run: runStop, busy: stopping } = useAsyncAction(async (id: string) => {
  await store.stopSession(id);
  pending.mark('session:' + id, () => {
    const x = store.sessions.find((y) => y.id === id);
    return !x || (x.status !== 'thinking' && x.status !== 'tool');
  });
});
function onStop(): void {
  const s = design.value;
  if (s && !sessionPending.value) void runStop(s.id);
}

const { run: runAnswer, busy: answering } = useAsyncAction((id: string, res: RpcExtensionUIResponse) =>
  store.answerUi(id, res),
);
function onAnswer(res: RpcExtensionUIResponse): void {
  const s = design.value;
  if (s) void runAnswer(s.id, res);
}

const { run: runEditor, busy: openingEditor } = useAsyncAction((id: string) => store.openEditor(id));
function onEditor(): void {
  const s = design.value;
  if (s) void runEditor(s.id);
}

// Stall banner «Перезапустити»: pending until the session shows life again.
const { run: runRestart, busy: restarting } = useAsyncAction(async (s: Session) => {
  const { id, status, lastActivityAt } = s;
  await store.restartSession(id);
  pending.mark('session:' + id, () => {
    const x = store.sessions.find((y) => y.id === id);
    return !x || x.status !== status || x.lastActivityAt !== lastActivityAt;
  });
});
function onRestart(): void {
  const s = design.value;
  if (s && !sessionPending.value) void runRestart(s);
}

// Composer ↻ — rehydrate a dormant design without sending anything.
async function onRefresh(): Promise<void> {
  const s = design.value;
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

// Composer ≡ — the same canned recap request as Агенти and Чат.
const { run: runSummary, busy: summarizing } = useAsyncAction(async (s: Session) => {
  await store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s));
});
function onSummary(): void {
  const s = design.value;
  if (s) void runSummary(s);
}

// The composer's effort and model chips: the pick shows at once, spins until the session
// reports it, and snaps back with a toast on a refusal.
const effortPick = useOptimisticValue<ThinkingLevel | undefined>(
  () => design.value?.effort,
  async (level) => {
    const s = design.value;
    if (s && level) await store.setEffort(s.id, level);
  },
);
let pickedProvider: string | undefined;
const modelPick = useOptimisticValue<string | undefined>(
  () => design.value?.model,
  async (model) => {
    const s = design.value;
    if (!s || !model) return;
    await store.setSessionModel(s.id, pickedProvider ? { model, provider: pickedProvider } : { model });
  },
);
function onSetModel(patch: { model: string; provider?: string }): void {
  pickedProvider = patch.provider;
  void modelPick.set(patch.model);
}

// A text selection in the log → a backlog card, the Чат path: filed for me, then shown in
// Агенти → Задачі. Guarded, so a repeated pick while the card is written cannot file it twice.
const { run: onNewTask } = useAsyncAction(async (text: string) => {
  const s = design.value;
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
  if (!card) return; // the store has already said why
  store.setBucket('tasks');
  void router.push({ name: 'agents' });
});

// ── Canvas ──────────────────────────────────────────────────────────────────
// Opening a design starts its preview — the call Агенти's ▶ makes (POST /sessions/:id/preview,
// idempotent while one runs) — unless the session browser already holds a page for it (the
// agent may be on a prototype route; reloading the root over it would lose that). The start is
// long (install + build in a fresh worktree), so it shows on the canvas (KBrowserPane
// `starting`), keyed per design so switching designs never mixes two starts up.
const commandMissing = ref(new Set<string>());
const noCommand = computed(
  () => !!design.value && (!selectedProject.value?.previewCommand || commandMissing.value.has(design.value.id)),
);
const previewStart = useKeyedAction(async (id: string) => {
  const s = store.sessions.find((x) => x.id === id);
  if (!s) return;
  const res = await store.startPreview(id);
  if (res.needsCommand) {
    commandMissing.value = new Set(commandMissing.value).add(id);
    return;
  }
  commandMissing.value.delete(id);
  if (res.url) void sessionBrowser.navigate(id, s.projectId, res.url);
});
async function ensurePreview(s: Session): Promise<void> {
  if (!sessionBrowser.available || !isBound.value || retired.value || s.archived) return;
  if (!selectedProject.value?.previewCommand) return; // the canvas says so instead
  // What main already has for this session (the view may predate this window).
  await sessionBrowser.refresh(s.id).catch(() => undefined);
  if (designId.value !== s.id || sessionBrowser.states[s.id] || previewStart.busyFor(s.id)) return;
  void previewStart.run(s.id);
}

// Браузер → «Надіслати агенту»: the same send Агенти uses (composables/useSendPicks.ts); the
// log is on screen beside the canvas, so nothing to switch to.
const { send: sendPicks, sending: sendingPicks } = useSendPicks({ mode: nextMode });

// ── README → «Задача →» ─────────────────────────────────────────────────────
// Offered once the design's README exists in its worktree — DocTaskDialog reads it from there.
// Read on open and again whenever a turn ends, the moments the agent may have written it.
const readme = ref<Record<string, boolean>>({});
const hasReadme = computed(() => !!design.value && readme.value[design.value.id] === true);
async function checkReadme(s: Session): Promise<void> {
  if (!s.designDir || !s.worktreePath) return;
  let found: boolean;
  try {
    found = !(await store.sessionFile(s.id, designReadmePath(s.designDir))).binary;
  } catch {
    found = false; // no such file yet
  }
  readme.value = { ...readme.value, [s.id]: found };
}
watch(running, (isRunning, wasRunning) => {
  if (wasRunning && !isRunning && design.value) void checkReadme(design.value);
});

// Everything a design needs when it comes on screen — on a click, a URL, a project switch, or
// once the snapshot (or a fresh launch's session_update) brings the selected one in.
watch(
  () => design.value?.id,
  (id) => {
    expandAll.value = EXPAND_ALL_NONE;
    logTab.value = 'log';
    const s = design.value;
    if (!id || !s) return;
    openHistory(s);
    void checkReadme(s);
    void ensurePreview(s);
  },
  { immediate: true },
);
// The command was just set (Налаштування → Команди, or by a teammate): start now.
watch(
  () => selectedProject.value?.previewCommand,
  (cmd) => {
    if (!cmd || !design.value) return;
    commandMissing.value = new Set();
    void ensurePreview(design.value);
  },
);

// ── Toolbar ─────────────────────────────────────────────────────────────────
// «Зберегти дизайн»: one Kermanych prompt (screenshots at 390 and 1280, README, commit). The
// POST returns as soon as the prompt is sent, so the button stays pending for the turn it
// started: until the session has run (thinking / tool) and settled again. A turn that never
// starts (a refused prompt, a session waiting for a slot) releases it after the cap.
const SAVE_TURN_CAP_MS = 30 * 60_000;
const saveAction = useAsyncAction(async (s: Session) => {
  await store.saveDesign(s.id);
  store.notify(t('design.page.notifySaving', { name: s.name }), 'info');
  let started = false;
  pending.mark(
    `design-save:${s.id}`,
    () => {
      const x = store.sessions.find((y) => y.id === s.id);
      if (!x) return true;
      const busy = x.status === 'thinking' || x.status === 'tool';
      if (busy) started = true;
      return started && !busy;
    },
    SAVE_TURN_CAP_MS,
  );
});
const saving = computed(
  () => !!design.value && (saveAction.busy.value || pending.isPending(`design-save:${design.value.id}`)),
);

// «Створити ПР», or «Закоміти» once the branch has an open PR — the finish sheet's secondary
// action, offered here without opening the sheet. The agent does the work in the log; a
// documentation-gate refusal (no README yet) comes back as the api's sentence in a toast.
const hasPr = computed(() => design.value?.prOpened === true || design.value?.status === 'in_review');
const prAction = useAsyncAction(async (s: Session) => {
  if (s.prOpened === true || s.status === 'in_review') {
    await store.commitChanges(s.id);
    store.notify(t('agents.notify.committing', { name: s.name }), 'info');
  } else {
    await store.createPr(s.id);
    store.notify(t('agents.notify.prCreating', { name: s.name }), 'info');
  }
});

// «Завершити» is the Агенти finish sheet itself (components/agents/FinishSheet.vue).
const finishOpen = ref(false);
const docTaskOpen = ref(false);

// ── «+ Новий дизайн» ────────────────────────────────────────────────────────
// A design is a card assigned to me with `design: true`, launched at once through the same
// from-task launch as «Нова задача» → «Запустити»; the api stamps `designDir` and opens the
// session with the Дизайнер instruction. A launch that fails after the card exists retries on
// that card (patched with the form) rather than minting a second one.
const newOpen = ref(false);
const newTopic = ref('');
const newDescription = ref('');
const newBase = ref('');
const newBranches = ref<string[]>([]);
const newBranchesLoading = ref(false);
const newError = ref<string | null>(null);
const newCardId = ref<string | null>(null);
const topicField = ref<InstanceType<typeof KField> | null>(null);
let branchesRun = 0;

// The fork base, as the launcher offers it: the project's default first, then every branch
// once the repo answers. A reopened modal drops an older reply.
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

function openNew(): void {
  const pid = store.selectedProjectId;
  if (!pid) return;
  newTopic.value = '';
  newDescription.value = '';
  newError.value = null;
  newCardId.value = null;
  void loadBranches(pid);
  newOpen.value = true;
  void nextTick(() => topicField.value?.focus());
}

const createAction = useAsyncAction(createDesign, {
  onError: (e) => {
    newError.value = errorText(e);
  },
});
const creating = computed(() => createAction.busy.value);

async function createDesign(): Promise<void> {
  const pid = store.selectedProjectId;
  const title = newTopic.value.trim();
  if (!pid || !title) return;
  const userId = auth.user?.id;
  if (!userId) {
    newError.value = t('agents.launcher.loginFirst');
    return;
  }
  // A design needs a worktree, so the project must be bound here, and a card, so it must be in
  // the cloud — the launcher's two gates, said inside the modal.
  if (!isBound.value) {
    newError.value = t('agents.hints.bind');
    return;
  }
  if (projects.listRead && !projects.byId.has(pid)) {
    newError.value = t('agents.hints.publishFirst');
    return;
  }
  newError.value = null;
  const description = newDescription.value.trim();
  const base = newBase.value.trim();
  let cardId = newCardId.value;
  if (cardId) {
    if (!(await board.updateTaskFields(cardId, { title, description, branch: base }))) return;
  } else {
    const project = selectedProject.value;
    const card = await board.createTask({
      projectId: pid,
      title,
      ...(description ? { description } : {}),
      prefix: 'design',
      worktree: true,
      design: true,
      assigneeId: userId,
      ...(base ? { branch: base } : {}),
      ...(project?.defaultModel ? { model: project.defaultModel } : {}),
      ...(project?.defaultEffort ? { effort: project.defaultEffort } : {}),
    });
    if (!card) {
      newError.value = t('design.new.cardFailed');
      return;
    }
    cardId = card.id;
    newCardId.value = card.id;
  }
  const session = await api.createSessionFromTask(cardId);
  newOpen.value = false;
  if (store.selectedProjectId === pid) select(session.id);
}

// ── Layout ──────────────────────────────────────────────────────────────────
// The rail and the log carry persisted widths; the canvas flexes into the rest and never
// drops below its floor.
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
  storageKey: 'kermanych.design.rail-width',
  defaultSize: 220,
  min: MIN_RAIL,
  edge: 'right',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_CANVAS - (design.value ? logWidth.value : 0) : Number.POSITIVE_INFINITY,
});
const {
  size: logWidth,
  resizing: logResizing,
  startResize: startLogResize,
  onKeydown: onLogResizeKeydown,
  refresh: refreshLogWidth,
} = useResizablePanel({
  storageKey: 'kermanych.design.log-width',
  defaultSize: 340,
  min: MIN_LOG,
  // The log sits right of its seam, so dragging left widens it.
  edge: 'left',
  max: () => (contentEl.value ? contentEl.value.clientWidth - MIN_CANVAS - railWidth.value : Number.POSITIVE_INFINITY),
});

onMounted(() => {
  refreshRailWidth();
  refreshLogWidth();
});
</script>

<style scoped lang="scss">
.design {
  height: 100%; // the work area (MainLayout .shell__workarea), which the terminal panel shares
  overflow: hidden;
  padding: var(--k-sp-3);
  display: flex;
  flex-direction: column;
}

.design__content {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

// While dragging a seam, force the col-resize cursor everywhere and kill text selection.
.design__content--resizing,
.design__content--resizing * {
  cursor: col-resize !important;
  user-select: none;
}

// ── Rail (the Чат history rail) ──
.design__rail {
  flex: none;
  min-width: 0;
  overflow-y: auto;
  padding: var(--k-sp-4);
}

.design__rail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2) var(--k-sp-3);
  margin-bottom: var(--k-sp-3);
}

.design__rail-title {
  display: flex;
  align-items: baseline;
}

.design__rail-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.design__rail-count {
  margin-left: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.design__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.design__rail-empty {
  margin: 0;
  padding: 24px 2px;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// ── Seams ──
.design__resizer {
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

.design__content--resizing .design__resizer::before {
  background: var(--k-accent);
}

// ── Stage: the bar over the canvas ──
.design__stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

// The Агенти / Чат detail bar's geometry, so the screens read as one system.
.design__bar {
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

.design__id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.design__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.design__branch {
  min-width: 0;
  overflow: hidden;
}

.design__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.design__canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// Why there is no canvas: centred, in the muted ink of the Агенти pane blanks.
.design__canvas-note {
  flex: 1;
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-2);
  padding: 24px;
  text-align: center;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-faint);
}

// Over the saved folder (web build): one line at the top, the folder takes the rest.
.design__canvas-note--bar {
  flex: 0 0 auto;
  padding: 10px 20px;
  border-bottom: 1px solid var(--k-line);
}

.design__canvas :deep(.design-folder) {
  flex: 1;
  min-height: 0;
}

.design__canvas-text {
  margin: 0;
  max-width: 48ch;
}

.design__canvas-link {
  color: var(--k-accent);
  font-size: var(--k-fs-sm);
}

// ── Log ──
.design__log {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.design__log-tabs {
  flex: none;
  padding: 0 12px;
}

.design__log-ctl {
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

// Bare, so it flows flat on the surface like the Агенти embedded panel; `min-height: 0` lets
// its own log scroll.
.design__log .design__panel {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}

.design__log-empty {
  margin: auto;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.design__detail-skeleton {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
}

.design__detail-blank,
.design__blank {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

// ── «+ Новий дизайн» ──
.design__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.design__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
