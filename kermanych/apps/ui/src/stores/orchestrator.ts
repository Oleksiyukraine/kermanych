// apps/ui/src/stores/orchestrator.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Socket } from 'socket.io-client';
import type {
  BranchPrefix,
  Platform,
  ImageInput,
  Project,
  Session,
  TaskDraft,
  TranscriptEntry,
  ServerEvent,
  RpcExtensionUIResponse,
} from '@kermanych/core';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include); status.js has a direct export.
import { shouldNotify } from '@kermanych/core/status';
import { connectSocket } from '../lib/socket';
import { api, type MessageMode } from '../lib/api';
import { applyTranscriptUpdate } from './transcript-update';

export type Toast = { id: string; message: string; kind: 'error' | 'info' };

// Native-notification copy for the attention-worthy statuses shouldNotify() fires on.
const STATUS_LABEL: Partial<Record<Session['status'], string>> = {
  waiting_input: 'потрібна відповідь',
  error: 'помилка',
  conflict: 'конфлікт злиття',
  done: 'завершено',
};

export const useOrchestrator = defineStore('orchestrator', () => {
  // LOCAL project rows, streamed from the api over the socket. Each row is a cloud
  // project's offline config cache plus this machine's binding (localRepoPath, "" when
  // unbound). Cloud-side project metadata and membership live in stores/projects.ts.
  const projects = ref<Project[]>([]);
  const sessions = ref<Session[]>([]);
  const transcripts = ref<Record<string, TranscriptEntry[]>>({});
  const selectedProjectId = ref<string | undefined>(undefined);
  const selectedWorkspaceId = ref<string | undefined>(undefined);
  // projectId -> workspaceId, pushed in by useProjects.load(). This store must NOT
  // import useProjects — that store already depends on this one for notify() and the
  // registry sync — so the map travels one way, downwards.
  const projectWorkspace = ref<Record<string, string>>({});
  const selectedSessionId = ref<string | undefined>(undefined);
  const previews = ref<Record<string, string>>({});
  const toasts = ref<Toast[]>([]);
  // Which Агенти bucket the sidebar shows (v3). Lives here because the sidebar (MainLayout)
  // sets it while the filter lives in AgentsPage. active = live agents; tasks = backlog;
  // archived = set aside; history = merged/done/stopped.
  const selectedBucket = ref<'active' | 'tasks' | 'archived' | 'history'>('active');
  function setBucket(b: 'active' | 'tasks' | 'archived' | 'history'): void { selectedBucket.value = b; }

  let socket: Socket | undefined;

  // Reduce a ServerEvent into state — mirrors the legacy MVP store exactly.
  function reduce(e: ServerEvent): void {
    if (e.type === 'snapshot') {
      projects.value = e.projects;
      sessions.value = e.sessions;
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
      // Native notification on an attention-worthy transition, only while the desktop
      // window is unfocused. Guarded so the browser build (no Notification) never throws.
      if (
        shouldNotify(prev, e.session.status) &&
        typeof document !== 'undefined' &&
        !document.hasFocus() &&
        typeof Notification !== 'undefined'
      ) {
        const n = new Notification(e.session.name, {
          body: STATUS_LABEL[e.session.status] ?? e.session.status,
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
    } else if (e.type === 'transcript_append') {
      transcripts.value = {
        ...transcripts.value,
        [e.sessionId]: [...(transcripts.value[e.sessionId] ?? []), e.entry],
      };
    } else if (e.type === 'transcript_reset') {
      transcripts.value = { ...transcripts.value, [e.sessionId]: e.entries };
    } else if (e.type === 'transcript_update') {
      const list = transcripts.value[e.sessionId];
      if (list) {
        const next = applyTranscriptUpdate(list, e);
        if (next !== list) transcripts.value = { ...transcripts.value, [e.sessionId]: next };
      }
    }
  }

  function connect(): void {
    if (socket) return;
    socket = connectSocket(reduce);
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
  function patchProject(id: string, body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }) {
    return api.patchProject(id, body);
  }

  function setProjectBinding(id: string, localRepoPath: string) {
    return api.setProjectBinding(id, localRepoPath);
  }

  function syncProjects(cloud: Parameters<typeof api.syncProjects>[0], prune = false) {
    return api.syncProjects(cloud, prune);
  }

  function createSession(
    projectId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
    asTask = false,
    platform?: Platform,
    baseBranch?: string,
  ) {
    return api.createSession(projectId, name, task, model, images, worktree, prefix, asTask, platform, baseBranch);
  }

  function createChat(projectId: string) {
    return api.createChat(projectId);
  }

  function promoteChat(id: string, taskId: string) {
    return api.promoteChat(id, taskId);
  }

  function startTask(id: string, draft?: TaskDraft & { images?: ImageInput[] }) {
    return api.startTask(id, draft);
  }

  function updateTask(id: string, patch: TaskDraft) {
    return api.updateTask(id, patch);
  }

  function moveTask(id: string, projectId: string) {
    return api.moveTask(id, projectId);
  }

  function sendMessage(id: string, text: string, mode: MessageMode, images?: ImageInput[]) {
    return api.sendMessage(id, text, mode, images);
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

  async function loadTranscript(id: string) {
    const entries = await api.loadTranscript(id);
    transcripts.value = { ...transcripts.value, [id]: entries };
    return entries;
  }

  // Wake a dormant session and pull its history back. The server broadcasts
  // `transcript_reset` from the resume itself, so the refetch is belt-and-braces: it also
  // covers the already-live case, where the server has nothing new to announce.
  async function resumeSession(id: string) {
    await api.resumeSession(id);
    return loadTranscript(id);
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

  function fileDiff(id: string, path: string) {
    return api.fileDiff(id, path);
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

  function createPr(id: string) {
    return api.createPr(id);
  }

  // Minimal transient notifications. notify() pushes a toast that auto-dismisses;
  // components read `toasts` and may dismiss one early.
  function notify(message: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    toasts.value = [...toasts.value, { id, message, kind }];
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
    selectedProjectId,
    selectedSessionId,
    selectedWorkspaceId,
    projectWorkspace,
    setProjectWorkspaces,
    selectWorkspace,
    selectedBucket,
    setBucket,
    connect,
    selectProject,
    selectSession,
    createSession,
    createChat,
    promoteChat,
    startTask,
    updateTask,
    moveTask,
    sendMessage,
    answerUi,
    stopSession,
    deleteSession,
    branchSession,
    reviewSession,
    mergeBranch,
    reopenSession,
    loadTranscript,
    resumeSession,
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
    fileDiff,
    finishSession,
    createPr,
    archiveSession,
    unarchiveSession,
    toasts,
    notify,
    dismissToast,
    openEditor,
    resolveConflict,
    restartSession,
  };
});
