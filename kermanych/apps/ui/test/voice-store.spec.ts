// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { VOICE_SILENCE_HANGUP_MS, type ServerEvent, type Session, type TranscriptEntry } from '@kermanych/core';
import type { LiveEvent, VoiceConnectionHandlers } from '../src/lib/voice-connection';

// The voice conversation's bridge (docs/specs/2026-11-02-voice-conversation.md) with GPT-Live's
// data channel scripted: what the store sends to the agent, and what it tells GPT-Live to say.

const sendMessage = vi.fn();
const answerUi = vi.fn();
let reduce: ((e: ServerEvent) => void) | undefined;
vi.mock('../src/lib/api', () => ({
  api: {
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    answerUi: (...args: unknown[]) => answerUi(...args),
    voiceSession: () => Promise.resolve({ id: 'live_1', sdp: 'answer' }),
    models: () => Promise.resolve([]),
  },
}));
vi.mock('../src/lib/socket', () => ({
  connectSocket: (fn: (e: ServerEvent) => void) => {
    reduce = fn;
    return {};
  },
}));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k } }));
vi.mock('../src/stores/auth', () => ({ useAuth: () => ({ language: 'uk' }) }));

const sent: Record<string, unknown>[] = [];
let handlers: VoiceConnectionHandlers | undefined;
const close = vi.fn();
vi.mock('../src/lib/voice-connection', () => ({
  connectVoice: async (_exchange: unknown, h: VoiceConnectionHandlers) => {
    handlers = h;
    return { send: (e: Record<string, unknown>) => sent.push(e), setMicEnabled: () => {}, micLevel: () => 0, setGate: () => {}, close };
  },
  micErrorWords: (e: unknown) => e,
}));

import { useOrchestrator } from '../src/stores/orchestrator';
import { useVoice } from '../src/stores/voice';

const live = (e: LiveEvent) => handlers!.onEvent(e);
const sentOf = (type: string) => sent.filter((e) => e.type === type);

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', name: 'Агент', task: 't', worktreePath: '/w', branch: 'b', worktree: true,
    kind: 'agent', status: 'done', createdAt: '', lastActivityAt: '',
    ...patch,
  } as Session;
}
// `ago`: history written before the conversation began.
const entry = (kind: 'user_text' | 'assistant_text', id: string, text: string, ago = 0): TranscriptEntry => ({ kind, id, at: Date.now() - ago, text });

async function talking() {
  const store = useOrchestrator();
  store.connect();
  reduce!({ type: 'session_update', session: session() });
  reduce!({ type: 'transcript_reset', sessionId: 's1', entries: [entry('user_text', 'u0', 'старе', 60_000), entry('assistant_text', 'a0', 'стара відповідь', 60_000)] });
  const voice = useVoice();
  await voice.start('s1');
  live({ type: 'session.started' });
  return { store, voice };
}

describe('the voice store bridges GPT-Live and the agent', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessage.mockReset().mockResolvedValue(undefined);
    answerUi.mockReset().mockResolvedValue(undefined);
    sent.length = 0;
    close.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('sends what the operator said as a voice message, in the mode typed text would take', async () => {
    await talking();
    live({ type: 'session.input_transcript.delta', delta: 'Додай ', start_ms: 100, end_ms: 500 });
    live({ type: 'session.delegation.created', offset_ms: 900, delegation: { id: 'del_1', target: 'client' } });
    // The phrase's last words arrive after the delegation event.
    live({ type: 'session.input_transcript.delta', delta: 'тест', start_ms: 600, end_ms: 900 });
    await vi.advanceTimersByTimeAsync(800);

    expect(sendMessage).toHaveBeenCalledWith('s1', 'Додай тест', 'follow_up', [], true);
    expect(sentOf('session.thinking.append')[0]).toMatchObject({ delegation_id: 'del_1' });
  });

  it('has GPT-Live retell the reply once the turn ends, under the delegation that started it — and never an older one', async () => {
    await talking();
    live({ type: 'session.input_transcript.delta', delta: 'що далі?', start_ms: 100, end_ms: 500 });
    live({ type: 'session.delegation.created', offset_ms: 600, delegation: { id: 'del_1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(800);

    reduce!({ type: 'session_update', session: session({ status: 'thinking' }) });
    reduce!({ type: 'transcript_append', sessionId: 's1', entry: { kind: 'user_text', id: 'u1', at: Date.now(), text: 'що далі?', via: 'voice' } });
    reduce!({ type: 'transcript_append', sessionId: 's1', entry: entry('assistant_text', 'a1', 'Далі тести.') });
    reduce!({ type: 'session_update', session: session({ status: 'done' }) });

    const said = sentOf('session.commentary.append');
    expect(said).toEqual([{ type: 'session.commentary.append', delegation_id: 'del_1', content: 'Далі тести.' }]);
  });

  it('reads the agent\'s question and answers it with the option the operator named', async () => {
    await talking();
    const req = { type: 'extension_ui_request' as const, id: 'q1', method: 'select', title: 'Як робимо?', options: ['Швидко', 'Надійно'] };
    reduce!({ type: 'session_update', session: session({ status: 'waiting_input', pendingUiRequest: req }) });
    expect(sentOf('session.commentary.append').at(-1)?.content).toContain('2) Надійно');

    live({ type: 'session.input_transcript.delta', delta: 'давай другий', start_ms: 100, end_ms: 500 });
    live({ type: 'session.delegation.created', offset_ms: 600, delegation: { id: 'del_2', target: 'client' } });
    await vi.advanceTimersByTimeAsync(800);

    expect(answerUi).toHaveBeenCalledWith('s1', { type: 'extension_ui_response', id: 'q1', value: 'Надійно' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('says the agent failed and then ends the conversation', async () => {
    const { voice } = await talking();
    reduce!({ type: 'session_update', session: session({ status: 'thinking' }) });
    reduce!({ type: 'session_update', session: session({ status: 'error', error: 'omp впав' }) });

    expect(sentOf('session.commentary.append').at(-1)?.content).toContain('omp впав');
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(voice.phase).toBe('idle');
    expect(close).toHaveBeenCalled();
  });

  it('hangs up after the silence window, but not while the agent works', async () => {
    const { voice } = await talking();
    reduce!({ type: 'session_update', session: session({ status: 'thinking' }) });
    await vi.advanceTimersByTimeAsync(VOICE_SILENCE_HANGUP_MS + 1000);
    expect(voice.phase).toBe('live');

    reduce!({ type: 'session_update', session: session({ status: 'done' }) });
    await vi.advanceTimersByTimeAsync(VOICE_SILENCE_HANGUP_MS + 1000);
    expect(sentOf('session.close')).toHaveLength(1);
  });

  it('hangs up while only the background is heard (docs/specs/2026-11-04-voice-background-noise.md)', async () => {
    await talking();
    for (let at = 0; at <= VOICE_SILENCE_HANGUP_MS; at += 30_000) {
      live({ type: 'session.input_transcript.delta', delta: 'прогноз погоди ', start_ms: at, end_ms: at + 2000 });
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sentOf('session.close')).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
