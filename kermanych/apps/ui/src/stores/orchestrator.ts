// apps/ui/src/stores/orchestrator.ts
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { Socket } from 'socket.io-client';
import type {
  NativeHarness,
  ImageInput,
  Project,
  Session,
  TranscriptEntry,
  SubagentNode,
  ThinkingLevel,
  ServerEvent,
  RpcExtensionUIResponse,
  ModelOption,
  DocsWriteKind,
  MachineAlert,
} from '@kermanych/core';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include); status.js has a direct export.
import { shouldNotify } from '@kermanych/core/status';
import { connectSocket } from '../lib/socket';
import { api, type MessageMode } from '../lib/api';
import { applyTranscriptUpdate } from './transcript-update';
import { machineAlertView } from '../lib/machine-alert';
import { globalTr } from '../boot/i18n';
import { readBucket, type Bucket } from '../lib/buckets';
import { unsettledOutgoing, type OutgoingMessage } from '../lib/outgoing';
import { PENDING_TIMEOUT_MS } from './pending';
import { confirmAction } from '../lib/confirm';

// The persisted selection (see `savedSelection` in the store). Guarded both ways: a missing
// or unreadable value is simply «nothing selected».
const SELECTION_KEY = 'kermanych.selection';
// A bucket saved before «Активні», «Очікують» and «Помилки» merged reads as «Агенти»
// (lib/buckets.ts readBucket), so the operator lands where those cards went.
type SavedSelection = { workspace?: string; project?: string; session?: string; bucket?: Bucket };
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
function readSelection(): SavedSelection {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '{}') as Record<string, unknown>;
    const out: SavedSelection = {};
    const workspace = str(raw.workspace);
    const project = str(raw.project);
    const session = str(raw.session);
    const bucket = readBucket(raw.bucket);
    if (workspace) out.workspace = workspace;
    if (project) out.project = project;
    if (session) out.session = session;
    if (bucket) out.bucket = bucket;
    return out;
  } catch {
    return {};
  }
}
function writeSelection(sel: { workspace: string | undefined; project: string | undefined; session: string | undefined; bucket: Bucket }): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(sel));
  } catch {
    // storage refused: the selection still holds until the next reload
  }
}

// `action`: one button on the toast (the watchdog's «Зупинити команду»); pressing it runs
// `run` and dismisses the toast.
export type Toast = {
  id: string;
  message: string;
  kind: 'error' | 'info';
  action?: { label: string; run: () => void | Promise<void> };
};

// i18n keys for the attention-worthy statuses shouldNotify() fires on. Resolved through
// globalTr at notification time (point-in-time copy), the same adapter the api client uses.
const STATUS_LABEL_KEY: Partial<Record<Session['status'], string>> = {
  waiting_input: 'agents.sessionStatus.waiting_input',
  error: 'agents.sessionStatus.error',
  conflict: 'agents.sessionStatus.conflict',
  done: 'agents.sessionStatus.done',
  in_review: 'agents.sessionStatus.in_review',
};

export const useOrchestrator = defineStore('orchestrator', () => {
  // LOCAL project rows, streamed from the api over the socket. Each row is a cloud
  // project's offline config cache plus this machine's binding (localRepoPath, "" when
  // unbound). Cloud-side project metadata and membership live in stores/projects.ts.
  const projects = ref<Project[]>([]);
  const sessions = ref<Session[]>([]);
  const transcripts = ref<Record<string, TranscriptEntry[]>>({});
  // Messages sent from the composer that the transcript does not hold yet — rendered as the
  // «надсилаю…» bubble (lib/outgoing.ts). Keyed by session id, like `transcripts`.
  const outgoing = ref<Record<string, OutgoingMessage[]>>({});
  // The socket's first `snapshot` has arrived. Until then an empty `sessions` / `projects`
  // means «not loaded», not «none», and the board / sidebar show a skeleton.
  const snapshotReceived = ref(false);
  // Per-session subagent tree for the agent map: the socket snapshot carries every live
  // session's tree, `subagents_update` keeps each fresh. Keyed by session id, as `transcripts`.
  const subagents = ref<Record<string, SubagentNode[]>>({});
  // The selection (workspace / project / agent) and the Агенти bucket survive a reload and a
  // restart: read once here, written on every change below. An id that no longer exists is
  // dropped once the first snapshot shows what does (see `reduce`).
  const savedSelection = readSelection();
  const selectedProjectId = ref<string | undefined>(savedSelection.project);
  const selectedWorkspaceId = ref<string | undefined>(savedSelection.workspace);
  // projectId -> workspaceId, pushed in by useProjects.load(). This store must NOT
  // import useProjects — that store already depends on this one for notify() and the
  // registry sync — so the map travels one way, downwards.
  const projectWorkspace = ref<Record<string, string>>({});
  const selectedSessionId = ref<string | undefined>(savedSelection.session);
  const previews = ref<Record<string, string>>({});
  const toasts = ref<Toast[]>([]);
  // The omp model catalog for THIS machine (see loadModels). Empty until it lands — and empty
  // for good if omp cannot be read — so every picker built on it degrades to «за замовчуванням».
  const models = ref<ModelOption[]>([]);
  // Which «Агенти» tab the page shows. Lives here, not in AgentsPage, because launching from
  // Чат (promote, «В беклог») picks the tab before the page mounts. See lib/buckets.ts for
  // what each bucket holds.
  const selectedBucket = ref<Bucket>(savedSelection.bucket ?? 'agents');
  watch(
    [selectedWorkspaceId, selectedProjectId, selectedSessionId, selectedBucket],
    ([workspace, project, session, bucket]) => writeSelection({ workspace, project, session, bucket }),
  );
  function setBucket(b: Bucket): void { selectedBucket.value = b; }

  // File-manager dock: a global panel (KFileManager) that shows the selected session's
  // worktree tree — or, with no session selected, the selected project's checkout — docked
  // to the left of or right of the page, VS Code / Zed style. It used to be the «Файли» tab
  // of the detail panel; lifting it to the shell lets it stand beside any view. Visibility
  // and side persist so a reload keeps the operator's layout.
  const fileManagerVisible = ref(localStorage.getItem('kermanych.fileManager.visible') === '1');
  const fileManagerSide = ref<'left' | 'right'>(
    localStorage.getItem('kermanych.fileManager.side') === 'right' ? 'right' : 'left',
  );
  // One control per side. Clicking the side the panel is already docked to collapses it;
  // clicking the other side moves it there (and opens it if it was closed).
  function toggleFileManager(side: 'left' | 'right'): void {
    if (fileManagerVisible.value && fileManagerSide.value === side) {
      fileManagerVisible.value = false;
    } else {
      fileManagerSide.value = side;
      fileManagerVisible.value = true;
    }
    localStorage.setItem('kermanych.fileManager.visible', fileManagerVisible.value ? '1' : '0');
    localStorage.setItem('kermanych.fileManager.side', fileManagerSide.value);
  }

  let socket: Socket | undefined;

  // Stores that keep a slice of the api's state of their own (stores/minion.ts) listen here
  // rather than being imported: they need `notify` from this store, and an import both ways
  // would make the two modules circular. Called after `reduce` has applied the event.
  const listeners = new Set<(e: ServerEvent) => void>();
  function onServerEvent(fn: (e: ServerEvent) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function dispatch(e: ServerEvent): void {
    reduce(e);
    for (const fn of listeners) fn(e);
  }

  // Reduce a ServerEvent into state — mirrors the legacy MVP store exactly.
  function reduce(e: ServerEvent): void {
    if (e.type === 'snapshot') {
      projects.value = e.projects;
      sessions.value = e.sessions;
      // The snapshot is the whole truth on (re)connect: trees of sessions gone meanwhile go too.
      subagents.value = e.subagents;
      // A restored selection may name a project or agent deleted since (here or by a teammate).
      if (selectedProjectId.value && !e.projects.some((p) => p.id === selectedProjectId.value)) {
        selectedProjectId.value = undefined;
      }
      if (selectedSessionId.value && !e.sessions.some((x) => x.id === selectedSessionId.value)) {
        selectedSessionId.value = undefined;
      }
      snapshotReceived.value = true;
    } else if (e.type === 'project_update') {
      projects.value = [
        ...projects.value.filter((p) => p.id !== e.project.id),
        e.project,
      ];
    } else if (e.type === 'project_removed') {
      projects.value = projects.value.filter((p) => p.id !== e.projectId);
      sessions.value = sessions.value.filter((x) => x.projectId !== e.projectId);
      // The selected project just vanished (pruned here or deleted in the cloud) — fall
      // back to its WORKSPACE scope, not to nothing: an undefined workspace makes
      // scopedProjectIds() return every project id, so clearing it here would swap the
      // board from this group's tasks to every group's. selectWorkspace() models exactly
      // this state (group highlighted, no project) on purpose.
      if (selectedProjectId.value === e.projectId) {
        selectedProjectId.value = undefined;
        selectedSessionId.value = undefined;
      }
    } else if (e.type === 'session_update') {
      const prev = sessions.value.find((x) => x.id === e.session.id)?.status;
      sessions.value = [
        ...sessions.value.filter((x) => x.id !== e.session.id),
        e.session,
      ];
      // A completed session («Завершити», a merged discussion/review) closes its chat pane:
      // there is nothing left to do in it. Only on the transition, so opening an already
      // merged card from «Завершені» (to read it or ↻ restore it) still shows the chat.
      // Covers every source — this window's finish, another window, the api — because the
      // api echoes each status change here.
      if (prev !== undefined && prev !== 'merged' && e.session.status === 'merged' && selectedSessionId.value === e.session.id) {
        selectedSessionId.value = undefined;
      }
      // Native notification on an attention-worthy transition, only while the desktop
      // window is unfocused. Guarded so the browser build (no Notification) never throws.
      if (
        shouldNotify(prev, e.session.status) &&
        typeof document !== 'undefined' &&
        !document.hasFocus() &&
        typeof Notification !== 'undefined'
      ) {
        const key = STATUS_LABEL_KEY[e.session.status];
        const n = new Notification(e.session.name, {
          body: key ? globalTr.t(key) : e.session.status,
        });
        n.onclick = () => {
          window.kermanych?.focus();
          selectProject(e.session.projectId);
          selectSession(e.session.id);
        };
      }
    } else if (e.type === 'session_removed') {
      sessions.value = sessions.value.filter((x) => x.id !== e.sessionId);
      if (previews.value[e.sessionId]) {
        const next = { ...previews.value };
        delete next[e.sessionId];
        previews.value = next;
      }
      // Free the removed session's transcript too — previews above already do this. Left
      // behind, the map kept every deleted/merged session's entries for the window's whole
      // life, and a long-running board only ever added to it.
      if (transcripts.value[e.sessionId]) {
        const next = { ...transcripts.value };
        delete next[e.sessionId];
        transcripts.value = next;
      }
      // Free the removed session's subagent tree too, exactly as the transcript above.
      if (subagents.value[e.sessionId]) {
        const next = { ...subagents.value };
        delete next[e.sessionId];
        subagents.value = next;
      }
    } else if (e.type === 'transcript_append') {
      transcripts.value = {
        ...transcripts.value,
        [e.sessionId]: [...(transcripts.value[e.sessionId] ?? []), e.entry],
      };
      settleOutgoing(e.sessionId);
    } else if (e.type === 'transcript_reset') {
      transcripts.value = { ...transcripts.value, [e.sessionId]: e.entries };
      settleOutgoing(e.sessionId);
    } else if (e.type === 'transcript_update') {
      const list = transcripts.value[e.sessionId];
      if (list) {
        const next = applyTranscriptUpdate(list, e);
        if (next !== list) transcripts.value = { ...transcripts.value, [e.sessionId]: next };
      }
    } else if (e.type === 'subagents_update') {
      subagents.value = { ...subagents.value, [e.sessionId]: e.subagents };
    } else if (e.type === 'machine_alert') {
      onMachineAlert(e.alert);
    }
  }

  // A watchdog finding (spec decision 7): an in-app toast, plus a native notification while
  // the window is unfocused — the operator is likely in the very app eating the memory.
  function onMachineAlert(alert: MachineAlert): void {
    const view = machineAlertView(alert, (k, named) => globalTr.t(k, named ?? {}));
    const { sessionId, pid } = alert;
    const action =
      view.killable && sessionId && pid !== undefined
        ? { label: globalTr.t('machineAlert.kill'), run: () => void confirmKill(view.message, sessionId, pid) }
        : undefined;
    // Long enough to read a command name and reach for the button.
    notify(view.message, view.kind, 15_000, action);
    // A warn-level kill is the echo of the operator's own click: they are looking already.
    const ownKill = alert.killed && alert.level === 'warn';
    if (!ownKill && typeof document !== 'undefined' && !document.hasFocus() && typeof Notification !== 'undefined') {
      const n = new Notification(globalTr.t('machineAlert.title'), { body: view.message });
      n.onclick = () => {
        window.kermanych?.focus();
        const s = sessionId ? sessions.value.find((x) => x.id === sessionId) : undefined;
        if (s) {
          selectProject(s.projectId);
          selectSession(s.id);
        }
      };
    }
  }

  // The toast's «Kill» asks first, quoting the alert (which names the command): killing a
  // process is not undoable, and the agent sees its command fail.
  async function confirmKill(alertText: string, sessionId: string, pid: number): Promise<void> {
    const ok = await confirmAction({
      title: globalTr.t('confirmations.killCommand.title'),
      message: globalTr.t('confirmations.killCommand.message', { alert: alertText }),
      confirmLabel: globalTr.t('confirmations.label.kill'),
    });
    if (ok) await killAgentCommand(sessionId, pid);
  }

  // Success needs no toast here: the api echoes it as a `machine_alert` with `killed`.
  async function killAgentCommand(sessionId: string, pid: number): Promise<void> {
    try {
      const { ok } = await api.killAgentCommand(sessionId, pid);
      if (!ok) notify(globalTr.t('machineAlert.killGone'), 'error');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function connect(): void {
    if (socket) return;
    socket = connectSocket(dispatch);
    // The catalog describes this machine's omp install, not registry state, so the connect
    // that warms the store pulls it too.
    void loadModels();
  }

  function setProjectWorkspaces(map: Record<string, string>): void {
    projectWorkspace.value = map;
    // The invariant is "a selected project carries its own workspace", so a map that
    // arrives or changes after the click has to re-resolve it — otherwise a move, a
    // refresh, or a cold start that resolves after the first click leaves the scope
    // pointing at the wrong group, or at none, which silently widens the board to every
    // workspace. Guarded on the project: selectWorkspace()'s deliberately project-less
    // selection must stay untouched.
    if (selectedProjectId.value) selectedWorkspaceId.value = map[selectedProjectId.value];
  }

  // Scope = a workspace. Clears the project so every project-scoped screen falls back
  // to its "nothing selected" shell instead of showing a stale project. Optional id —
  // same shape as selectSession() below — because a deleted workspace has to leave the
  // scope empty, and there is no other writer: store state is only ever mutated through
  // these actions.
  function selectWorkspace(id?: string): void {
    selectedWorkspaceId.value = id;
    selectedProjectId.value = undefined;
    selectedSessionId.value = undefined;
  }

  // Scope = a project, which ALWAYS carries its own workspace: both rows highlight in
  // the tree, and the board's scope stays the group while «Проєкти» narrows it.
  // One argument on purpose — the notification handler above has only a projectId, and
  // an optional workspace argument would let it highlight a group that does not
  // contain this project. A local-only project has no cloud row, so the map has no
  // entry and the workspace clears, which is the honest answer.
  function selectProject(id: string): void {
    selectedProjectId.value = id;
    selectedWorkspaceId.value = projectWorkspace.value[id];
    selectedSessionId.value = undefined;
  }

  function selectSession(id?: string): void {
    selectedSessionId.value = id;
  }

  // Actions delegating to the REST api. There is deliberately no createProject/
  // deleteProject: projects are born and die in the cloud (stores/projects.ts), and the
  // local rows follow through syncProjects.
  function patchProject(id: string, body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; docFolders?: string[]; docsRequired?: boolean; defaultBranch?: string; conventions?: string }) {
    return api.patchProject(id, body);
  }

  function setProjectBinding(id: string, localRepoPath: string) {
    return api.setProjectBinding(id, localRepoPath);
  }

  function syncProjects(cloud: Parameters<typeof api.syncProjects>[0], prune = false) {
    return api.syncProjects(cloud, prune);
  }

  function createChat(projectId: string, native?: NativeHarness) {
    return api.createChat(projectId, native);
  }

  function promoteChat(id: string, taskId: string) {
    return api.promoteChat(id, taskId);
  }

  function setOutgoing(id: string, list: OutgoingMessage[]): void {
    const next = { ...outgoing.value };
    if (list.length) next[id] = list;
    else delete next[id];
    outgoing.value = next;
  }

  // Drops the bubbles the transcript now shows as real entries.
  function settleOutgoing(id: string): void {
    const list = outgoing.value[id];
    if (!list?.length) return;
    const left = unsettledOutgoing(list, transcripts.value[id] ?? []);
    if (left.length !== list.length) setOutgoing(id, left);
  }

  // The bubble shows at once; the real user entry replaces it when the transcript reports it.
  // A failed send removes the bubble and rethrows, so the caller can hand the text back to the
  // composer. A bubble the transcript never confirms (a native session pastes into its TUI and
  // records nothing) is dropped after PENDING_TIMEOUT_MS.
  async function sendMessage(id: string, text: string, mode: MessageMode, images?: ImageInput[]) {
    const msg: OutgoingMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      images: images ?? [],
      at: Date.now(),
    };
    setOutgoing(id, [...(outgoing.value[id] ?? []), msg]);
    const drop = () => setOutgoing(id, (outgoing.value[id] ?? []).filter((m) => m.id !== msg.id));
    try {
      const res = await api.sendMessage(id, text, mode, images);
      settleOutgoing(id);
      if (outgoing.value[id]?.some((m) => m.id === msg.id)) setTimeout(drop, PENDING_TIMEOUT_MS);
      return res;
    } catch (e) {
      drop();
      throw e;
    }
  }

  // The composer's effort chip. No optimistic patch: the api answers with the saved row AND
  // broadcasts `session_update`, so the chip follows what omp actually accepted.
  function setEffort(id: string, level: ThinkingLevel) {
    return api.setEffort(id, level);
  }

  // Fetched once: the catalog only changes when omp is upgraded or a provider credential
  // appears, neither of which happens while the window is open. Failures are swallowed — the
  // list is a convenience over omp's own default, and a «за замовчуванням»-only picker is fine.
  async function loadModels(force = false) {
    if (models.value.length && !force) return;
    try {
      models.value = await api.models();
    } catch {
      // Left empty on purpose — see above.
    }
  }

  // Change a running session's model/effort from the composer. Nothing swallowed: the api's
  // 400 carries omp's own sentence and the caller has a form to keep open.
  function setSessionModel(id: string, patch: { model?: string; provider?: string; effort?: ThinkingLevel }) {
    return api.setSessionModel(id, patch);
  }

  function answerUi(id: string, res: RpcExtensionUIResponse) {
    return api.answerUi(id, res);
  }

  function stopSession(id: string) {
    return api.stopSession(id);
  }

  function deleteSession(id: string) {
    return api.deleteSession(id);
  }

  function branchSession(id: string) {
    return api.branchSession(id);
  }

  function reviewSession(id: string) {
    return api.reviewSession(id);
  }

  function mergeBranch(id: string, summary?: string) {
    return api.mergeBranch(id, summary);
  }

  function archiveSession(id: string) {
    return api.archiveSession(id);
  }

  function unarchiveSession(id: string) {
    return api.unarchiveSession(id);
  }

  function renameSession(id: string, name: string) {
    return api.renameSession(id, name);
  }

  async function loadTranscript(id: string) {
    const entries = await api.loadTranscript(id);
    transcripts.value = { ...transcripts.value, [id]: entries };
    settleOutgoing(id);
    return entries;
  }

  // Wake a dormant session and pull its history back. The server broadcasts
  // `transcript_reset` from the resume itself, so the refetch is belt-and-braces: it also
  // covers the already-live case, where the server has nothing new to announce.
  async function resumeSession(id: string) {
    await api.resumeSession(id);
    return loadTranscript(id);
  }

  // «Запустити зараз» on a session waiting for an agent slot: the api starts it past the
  // limit and returns the row, which also arrives as `session_update`.
  async function runSessionNow(id: string) {
    const s = await api.runSessionNow(id);
    sessions.value = [...sessions.value.filter((x) => x.id !== s.id), s];
  }

  async function startPreview(id: string) {
    const res = await api.startPreview(id);
    if (res.url) previews.value = { ...previews.value, [id]: res.url };
    return res;
  }

  async function stopPreview(id: string) {
    await api.stopPreview(id);
    const next = { ...previews.value };
    delete next[id];
    previews.value = next;
  }

  function listBranches(id: string) {
    return api.listBranches(id);
  }

  function pullProject(id: string) {
    return api.pullProject(id);
  }

  function getEnv(id: string, file?: string) {
    return api.getEnv(id, file);
  }

  function saveEnv(id: string, patch: { file?: string; set?: Record<string, string>; remove?: string[] }) {
    return api.saveEnv(id, patch);
  }

  function finishInfo(id: string) {
    return api.finishInfo(id);
  }

  function prCheck(id: string) {
    return api.prCheck(id);
  }

  function fileDiff(id: string, path: string) {
    return api.fileDiff(id, path);
  }

  function sessionTree(id: string, path: string) {
    return api.sessionTree(id, path);
  }

  function sessionFile(id: string, path: string) {
    return api.sessionFile(id, path);
  }

  function sessionRaw(id: string, path: string) {
    return api.sessionRaw(id, path);
  }

  function projectTree(id: string, path: string) {
    return api.projectTree(id, path);
  }

  function projectFile(id: string, path: string) {
    return api.projectFile(id, path);
  }

  function projectRaw(id: string, path: string) {
    return api.projectRaw(id, path);
  }

  async function finishSession(id: string) {
    const res = await api.finish(id);
    // preview is stopped server-side on finish; drop its local url too.
    if (previews.value[id]) {
      const next = { ...previews.value };
      delete next[id];
      previews.value = next;
    }
    return res;
  }

  async function closeMerged(id: string) {
    const res = await api.closeMerged(id);
    // Same retirement as finishSession: the preview is stopped server-side; drop its url too.
    if (previews.value[id]) {
      const next = { ...previews.value };
      delete next[id];
      previews.value = next;
    }
    return res;
  }

  function createPr(id: string) {
    return api.createPr(id);
  }

  function commitChanges(id: string) {
    return api.commitChanges(id);
  }

  function completeDocs(id: string) {
    return api.completeDocs(id);
  }

  function writeDoc(id: string, kind: DocsWriteKind) {
    return api.writeDoc(id, kind);
  }

  // Minimal transient notifications. notify() pushes a toast that auto-dismisses;
  // components read `toasts` and may dismiss one early.
  function notify(message: string, kind: Toast['kind'] = 'info', ms = 4000, action?: Toast['action']) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    toasts.value = [...toasts.value, { id, message, kind, ...(action ? { action } : {}) }];
    setTimeout(() => dismissToast(id), ms);
  }

  function dismissToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function openEditor(id: string) {
    return api.openEditor(id);
  }

  function resolveConflict(id: string) {
    return api.resolveConflict(id);
  }

  function restartSession(id: string) {
    return api.restartSession(id);
  }

  function reopenSession(id: string) {
    return api.reopenSession(id);
  }

  return {
    projects,
    sessions,
    transcripts,
    outgoing,
    snapshotReceived,
    selectedProjectId,
    selectedSessionId,
    selectedWorkspaceId,
    projectWorkspace,
    setProjectWorkspaces,
    selectWorkspace,
    selectedBucket,
    setBucket,
    fileManagerVisible,
    fileManagerSide,
    toggleFileManager,
    connect,
    onServerEvent,
    selectProject,
    selectSession,
    createChat,
    promoteChat,
    sendMessage,
    setEffort,
    models,
    loadModels,
    setSessionModel,
    answerUi,
    stopSession,
    deleteSession,
    branchSession,
    reviewSession,
    mergeBranch,
    reopenSession,
    loadTranscript,
    subagents,
    resumeSession,
    runSessionNow,
    previews,
    startPreview,
    stopPreview,
    patchProject,
    setProjectBinding,
    syncProjects,
    listBranches,
    pullProject,
    getEnv,
    saveEnv,
    finishInfo,
    prCheck,
    fileDiff,
    sessionTree,
    sessionFile,
    sessionRaw,
    projectTree,
    projectFile,
    projectRaw,
    finishSession,
    closeMerged,
    createPr,
    commitChanges,
    completeDocs,
    writeDoc,
    archiveSession,
    unarchiveSession,
    renameSession,
    toasts,
    notify,
    dismissToast,
    openEditor,
    resolveConflict,
    restartSession,
  };
});
