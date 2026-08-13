// apps/ui/src/lib/api.ts
// Typed REST helpers against the Kermanych API (NestJS, global prefix "api").
import type {
  BranchPrefix,
  DirListing,
  ImageInput,
  Group,
  EnvFileView,
  Session,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';

const BASE =
  (typeof window !== 'undefined' && window.kermanych?.apiBase) ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:4317/api';

export type MessageMode = 'prompt' | 'follow_up' | 'steer';

// Turn a non-2xx Response into an Error carrying the server's message. Nest
// error bodies look like { statusCode, message, error }; message may be a
// string or an array of validation strings. Fall back to statusText.
async function toError(r: Response): Promise<Error> {
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  // NestJS message/answer endpoints return an empty body; tolerate no-JSON.
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

export const api = {
  createGroup: (name: string, projectDir: string, carryFiles?: string[]): Promise<Group> =>
    post<Group>('/groups', { name, projectDir, carryFiles }),

  deleteGroup: async (id: string): Promise<void> => {
    const r = await fetch(`${BASE}/groups/${id}`, { method: 'DELETE' });
    if (!r.ok) throw await toError(r);
  },

  createSession: (
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
  ): Promise<Session> =>
    post<Session>('/sessions', { groupId, name, task, model, images, worktree, prefix }),

  sendMessage: (id: string, text: string, mode: MessageMode, images?: ImageInput[]): Promise<unknown> =>
    post(`/sessions/${id}/message`, { text, mode, images }),

  answerUi: (id: string, res: RpcExtensionUIResponse): Promise<unknown> =>
    post(`/sessions/${id}/answer`, { res }),

  stopSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/stop`, {}),

  deleteSession: (id: string): Promise<Response> =>
    fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }),

  loadTranscript: (id: string): Promise<TranscriptEntry[]> =>
    get<TranscriptEntry[]>(`/sessions/${id}/transcript`),

  listDirs: (path?: string): Promise<DirListing> =>
    get<DirListing>(`/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  updateGroup: async (
    id: string,
    patch: { name?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[] },
  ): Promise<Group> => {
    const r = await fetch(`${BASE}/groups/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw await toError(r);
    return (await r.json()) as Group;
  },

  getEnv: (id: string, file?: string): Promise<EnvFileView> =>
    get<EnvFileView>(`/groups/${id}/env${file ? `?file=${encodeURIComponent(file)}` : ''}`),

  saveEnv: (
    id: string,
    patch: { file?: string; set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> => put<EnvFileView>(`/groups/${id}/env`, patch),

  startPreview: (id: string): Promise<{ url?: string; needsCommand?: boolean }> =>
    post(`/sessions/${id}/preview`, {}),

  stopPreview: (id: string): Promise<void> =>
    fetch(`${BASE}/sessions/${id}/preview`, { method: 'DELETE' }).then(() => undefined),

  finishInfo: (
    id: string,
  ): Promise<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[] }> =>
    get(`/sessions/${id}/finish`),

  finish: (
    id: string,
  ): Promise<{ merged: boolean; into: string } | { conflict: boolean; files: string[] }> =>
    post(`/sessions/${id}/finish`, {}),

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

  branchSession: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/branch`, {}),

  mergeBranch: (id: string, summary?: string): Promise<{ merged: boolean }> =>
    post<{ merged: boolean }>(`/sessions/${id}/merge`, { summary }),

};
