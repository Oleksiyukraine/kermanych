// apps/ui/src/lib/api.ts
// Typed REST helpers against the Kermanych API (NestJS, global prefix "api").
import type {
  BranchPrefix,
  Platform,
  DirListing,
  ImageInput,
  Project,
  EnvFileView,
  Session,
  SubscriptionUsage,
  TaskDraft,
  TranscriptEntry,
  ToolLine,
  RpcExtensionUIResponse,
} from '@kermanych/core';
import type { CloudProject } from '@kermanych/cloud';

const BASE =
  (typeof window !== 'undefined' && window.kermanych?.apiBase) ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:4317/api';

// The local API is guarded by SupabaseAuthGuard: every route except
// POST /auth/session needs the user's Supabase access token. boot/supabase.ts
// pushes the token in here on every auth state change, so this module never
// imports the auth store (that would be circular: store → api → store).
let authToken: string | undefined;
let onUnauthorized: (() => void) | undefined;

export function setAuthToken(token: string | undefined): void {
  authToken = token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function authHeaders(json: boolean): Record<string, string> {
  const h: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  if (authToken) h.authorization = `Bearer ${authToken}`;
  return h;
}

export type MessageMode = 'prompt' | 'follow_up' | 'steer';

// Turn a non-2xx Response into an Error carrying the server's message. Nest
// error bodies look like { statusCode, message, error }; message may be a
// string or an array of validation strings. Fall back to statusText.
async function toError(r: Response): Promise<Error> {
  // 401 means the cached token on the api no longer matches ours (expired
  // refresh, another machine signed out, api restarted with a cleared cache).
  // One hook, one place: every helper below funnels its failures through here.
  if (r.status === 401) onUnauthorized?.();
  const text = await r.text();
  let message = r.statusText || `HTTP ${r.status}`;
  if (text) {
    try {
      const body = JSON.parse(text) as {
        message?: string | string[];
        error?: string;
      };
      const m = Array.isArray(body.message)
        ? body.message.join(', ')
        : body.message;
      message = m || body.error || message;
    } catch {
      message = text;
    }
  }
  return new Error(message);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  // NestJS message/answer endpoints return an empty body; tolerate no-JSON.
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { headers: authHeaders(false) });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

// DELETE and PATCH used to be hand-rolled at five call sites, two of which never
// checked r.ok. Two helpers instead, so the Authorization header and the 401 hook
// cannot be forgotten at a new call site.
async function del(path: string): Promise<void> {
  const r = await fetch(BASE + path, { method: 'DELETE', headers: authHeaders(false) });
  if (!r.ok) throw await toError(r);
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

// One changed file, already paired into side-by-side rows by the api (see
// apps/api/src/worktree/split-diff.ts). A row fills the original column, the changed
// column, or both — that is what keeps the two columns aligned line for line.
export type DiffCell = { no: number; text: string };
export type DiffRow = {
  kind: 'ctx' | 'add' | 'del' | 'mod';
  old: DiffCell | null;
  new: DiffCell | null;
};
export type DiffHunk = { header: string; rows: DiffRow[] };
export type FileDiff = { hunks: DiffHunk[]; binary: boolean; truncated: boolean };

export const api = {
  // LOCAL project rows. Creation and deletion live in the cloud (see stores/projects.ts);
  // these routes cache cloud config and own this machine's binding.
  listProjects: (): Promise<Project[]> => get<Project[]>('/projects'),

  patchProject: (
    id: string,
    body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string },
  ): Promise<Project> => patchJson<Project>(`/projects/${id}`, body),

  setProjectBinding: (id: string, localRepoPath: string): Promise<Project> =>
    put<Project>(`/projects/${id}/binding`, { localRepoPath }),

  // `prune` is only safe when `projects` is the FULL cloud list; a single-project refresh
  // must leave it false or it would sweep every other cached row.
  syncProjects: (projects: CloudProject[], prune = false): Promise<Project[]> =>
    post<Project[]>('/projects/sync', { projects, prune }),

  createSession: (
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
  ): Promise<Session> =>
    post<Session>('/sessions', { projectId, name, task, model, images, worktree, prefix, platform, asTask, baseBranch }),

  createChat: (projectId: string): Promise<Session> =>
    post<Session>('/sessions/chat', { projectId }),

  // The user is NOT sent: the api takes it from the guard's cached token, so a board
  // client cannot launch a task on somebody else's behalf.
  createSessionFromTask: (taskId: string): Promise<Session> =>
    post<Session>('/sessions/from-task', { taskId }),

  // How many status pushes THIS machine still owes the cloud. Only the local process can
  // see that, so the board polls it (see the api controller for why it is not an event).
  cloudOutbox: (): Promise<{ pending: number }> =>
    get<{ pending: number }>('/cloud/outbox'),

  // What the provider plan behind this machine's agents has left (percent of each rolling
  // rate-limit window). Local-only, like the outbox above: only this process can ask omp.
  subscriptionUsage: (): Promise<SubscriptionUsage> =>
    get<SubscriptionUsage>('/usage/subscription'),

  promoteChat: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/promote`, {}),

  sendMessage: (id: string, text: string, mode: MessageMode, images?: ImageInput[]): Promise<unknown> =>
    post(`/sessions/${id}/message`, { text, mode, images }),

  answerUi: (id: string, res: RpcExtensionUIResponse): Promise<unknown> =>
    post(`/sessions/${id}/answer`, { res }),

  stopSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/stop`, {}),

  // Was Promise<Response> with no r.ok check; now it throws like every sibling.
  deleteSession: (id: string): Promise<void> => del(`/sessions/${id}`),

  loadTranscript: (id: string): Promise<TranscriptEntry[]> =>
    get<TranscriptEntry[]>(`/sessions/${id}/transcript`),

  getToolDetail: (sessionId: string, callId: string): Promise<{ lines: ToolLine[]; totalLines: number }> =>
    get<{ lines: ToolLine[]; totalLines: number }>(`/sessions/${sessionId}/tools/${encodeURIComponent(callId)}`),

  listDirs: (path?: string): Promise<DirListing> =>
    get<DirListing>(`/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  listBranches: (id: string): Promise<{ branches: string[]; current: string; default: string | null }> =>
    get<{ branches: string[]; current: string; default: string | null }>(`/projects/${id}/branches`),

  pullProject: (id: string): Promise<{ ok: boolean; out: string }> =>
    post<{ ok: boolean; out: string }>(`/projects/${id}/pull`, {}),

  pushProject: (id: string): Promise<{ ok: boolean; out: string }> =>
    post<{ ok: boolean; out: string }>(`/projects/${id}/push`, {}),

  getEnv: (id: string, file?: string): Promise<EnvFileView> =>
    get<EnvFileView>(`/projects/${id}/env${file ? `?file=${encodeURIComponent(file)}` : ''}`),

  saveEnv: (
    id: string,
    edits: { file?: string; set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> => put<EnvFileView>(`/projects/${id}/env`, edits),

  startPreview: (id: string): Promise<{ url?: string; needsCommand?: boolean }> =>
    post(`/sessions/${id}/preview`, {}),

  stopPreview: (id: string): Promise<void> => del(`/sessions/${id}/preview`),

  finishInfo: (
    id: string,
  ): Promise<{
    branch: string;
    target: string;
    ahead: number;
    dirty: boolean;
    conflicts: string[];
    files: { path: string; added: number; removed: number }[];
  }> => get(`/sessions/${id}/finish`),

  fileDiff: (id: string, path: string): Promise<FileDiff> =>
    get<FileDiff>(`/sessions/${id}/diff?path=${encodeURIComponent(path)}`),

  finish: (
    id: string,
  ): Promise<{ merged: boolean; into: string } | { conflict: boolean; files: string[] }> =>
    post(`/sessions/${id}/finish`, {}),

  createPr: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/pr`, {}),

  archiveSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/archive`, {}),

  unarchiveSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/unarchive`, {}),

  openEditor: (id: string): Promise<{ ok: boolean }> =>
    post(`/sessions/${id}/editor`, {}),

  resolveConflict: (id: string): Promise<{ ok: boolean }> =>
    post(`/sessions/${id}/resolve`, {}),

  restartSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/restart`, {}),

  resumeSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/resume`, {}),

  reopenSession: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/reopen`, {}),

  branchSession: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/branch`, {}),

  reviewSession: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/review`, {}),

  mergeBranch: (id: string, summary?: string): Promise<{ merged: boolean }> =>
    post<{ merged: boolean }>(`/sessions/${id}/merge`, { summary }),

  startTask: (id: string, draft: TaskDraft & { images?: ImageInput[] } = {}): Promise<Session> =>
    post<Session>(`/sessions/${id}/start`, draft),

  updateTask: (id: string, draft: TaskDraft): Promise<Session> =>
    patchJson<Session>(`/sessions/${id}`, draft),

  moveTask: (id: string, projectId: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/move`, { projectId }),

  // Token handoff to the local api. POST is @Public() on the server (the UI has
  // no bearer to present yet); DELETE and GET are guarded like everything else.
  authSession: (accessToken: string): Promise<{ userId: string; githubUsername?: string }> =>
    post<{ userId: string; githubUsername?: string }>('/auth/session', { accessToken }),

  clearAuthSession: (): Promise<void> => del('/auth/session'),

};
