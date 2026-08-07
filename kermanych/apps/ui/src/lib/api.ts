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

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // NestJS message/answer endpoints return an empty body; tolerate no-JSON.
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
    fetch(`${BASE}/sessions/${id}/transcript`).then(
      (r) => r.json() as Promise<TranscriptEntry[]>,
    ),
};
