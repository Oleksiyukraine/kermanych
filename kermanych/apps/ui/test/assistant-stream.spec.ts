import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CukChatAsk, CukChatReply } from '@kermanych/core';

// The streamed chat answer (docs/specs/2026-11-15-faster-assistant-answers.md): the browser
// reads NDJSON frames as they arrive, whatever the network split them into, and turns the
// stream's last line into the reply or the error.
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

import { ApiError, api, type AssistantProgress } from '../src/lib/api';

// The body as the network delivers it: raw byte pieces.
let parts: Uint8Array[];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const part of parts) c.enqueue(part);
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function ndjson(...frames: unknown[]): Uint8Array {
  return new TextEncoder().encode(frames.map((f) => `${JSON.stringify(f)}\n`).join(''));
}

const ASK = { text: 'hi', context: {} } as unknown as CukChatAsk;
const REPLY: CukChatReply = { text: 'Привіт.', actions: [], rejected: [], notices: [], ms: 7 };

describe('streamed chat answer', () => {
  it('hands each delta over as it arrives, even split mid-line and mid-character, then the reply', async () => {
    const bytes = ndjson({ type: 'delta', text: 'При' }, { type: 'delta', text: 'віт.' }, { type: 'reply', reply: REPLY });
    // 7-byte pieces: Cyrillic is two bytes in UTF-8, so some pieces end mid-character.
    parts = [];
    for (let i = 0; i < bytes.length; i += 7) parts.push(bytes.slice(i, i + 7));
    const seen: AssistantProgress[] = [];
    const reply = await api.cukChat(ASK, (p) => seen.push(p));
    expect(seen).toEqual([
      { type: 'delta', text: 'При' },
      { type: 'delta', text: 'віт.' },
    ]);
    expect(reply).toEqual(REPLY);
  });

  it('throws an error frame as the coded ApiError a refused request throws', async () => {
    parts = [
      ndjson(
        { type: 'delta', text: 'Почав' },
        { type: 'error', code: 'assistant_no_reply_timeout', message: 'асистент не відповів за 120 с', params: { seconds: 120 } },
      ),
    ];
    const err = await api.cukChat(ASK, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('assistant_no_reply_timeout');
    expect((err as ApiError).serverMessage).toBe('асистент не відповів за 120 с');
  });

  it('a stream that closes with neither a reply nor an error is a lost connection', async () => {
    parts = [ndjson({ type: 'delta', text: 'Почав' })];
    await expect(api.cukChat(ASK, () => {})).rejects.toThrow('management.assistant.streamLost');
  });
});
