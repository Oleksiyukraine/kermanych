// apps/ui/src/lib/api.ts
// Typed REST helpers against the Kermanych API (NestJS, global prefix "api").
import type {
  Group,
  Session,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';

const BASE = 'http://localhost:4317/api';

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

export const api = {
  createGroup: (name: string, projectDir: string): Promise<Group> =>
    post<Group>('/groups', { name, projectDir }),

  deleteGroup: (id: string): Promise<Response> =>
    fetch(`${BASE}/groups/${id}`, { method: 'DELETE' }),

  createSession: (
    groupId: string,
    name: string,
    task: string,
    model?: string,
  ): Promise<Session> =>
    post<Session>('/sessions', { groupId, name, task, model }),

  sendMessage: (id: string, text: string, mode: MessageMode): Promise<unknown> =>
    post(`/sessions/${id}/message`, { text, mode }),

  answerUi: (id: string, res: RpcExtensionUIResponse): Promise<unknown> =>
    post(`/sessions/${id}/answer`, { res }),

  stopSession: (id: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/sessions/${id}/stop`, {}),

  deleteSession: (id: string): Promise<Response> =>
    fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }),

  loadTranscript: (id: string): Promise<TranscriptEntry[]> =>
    get<TranscriptEntry[]>(`/sessions/${id}/transcript`),
};
