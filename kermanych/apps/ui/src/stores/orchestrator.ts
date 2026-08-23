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
  const selectedSessionId = ref<string | undefined>(undefined);
  const previews = ref<Record<string, string>>({});
  const toasts = ref<Toast[]>([]);

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
      // The selected project just vanished (pruned here or deleted in the cloud) —
      // fall back to the "nothing selected" shell so the header/board don't dangle.
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

  function selectProject(id: string): void {
    selectedProjectId.value = id;
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

  function promoteChat(id: string) {
    return api.promoteChat(id);
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

  function getEnv(id: string, file?: string) {
    return api.getEnv(id, file);
  }

  function saveEnv(id: string, patch: { file?: string; set?: Record<string, string>; remove?: string[] }) {
    return api.saveEnv(id, patch);
  }

  function finishInfo(id: string) {
    return api.finishInfo(id);
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
    previews,
    startPreview,
    stopPreview,
    patchProject,
    setProjectBinding,
    syncProjects,
    listBranches,
    getEnv,
    saveEnv,
    finishInfo,
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
