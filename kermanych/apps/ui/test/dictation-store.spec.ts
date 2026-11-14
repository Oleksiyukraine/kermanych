// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DICTATION_COMPOSER_IDLE_MS, DICTATION_IDLE_MS, DICTATION_PAUSE_MS } from '@kermanych/core';
import type { LiveEvent, VoiceConnectionHandlers } from '../src/lib/voice-connection';

// Voice dictation's store on the local recogniser (docs/specs/2026-11-14-local-voice-dictation.md)
// with the microphone scripted and the transcription answers held back: what reaches the owner
// and in which order, how it stops, and the voice conversation it mutes meanwhile.

type Answer = PromiseWithResolvers<{ text: string }>;
const answers: Answer[] = [];
const transcribe = vi.fn<(body: { audio: string; language: string }) => Promise<{ text: string }>>();
const sttWarm = vi.fn();
vi.mock('../src/lib/api', () => ({
  api: {
    sttWarm: () => sttWarm(),
    transcribe: (body: { audio: string; language: string }) => transcribe(body),
    voiceSession: () => Promise.resolve({ id: 'live_1', sdp: 'answer' }),
    models: () => Promise.resolve([]),
  },
}));
vi.mock('../src/lib/socket', () => ({ connectSocket: () => ({}) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k } }));
vi.mock('../src/stores/auth', () => ({ useAuth: () => ({ language: 'uk' }) }));

// The microphone: each tick drains one 100 ms block at the scripted level.
const BLOCK = 1600;
type Mic = { level: number; close: Mock };
const mics: Mic[] = [];
vi.mock('../src/lib/voice-capture', () => ({
  openCapture: async () => {
    const m: Mic = { level: 0, close: vi.fn() };
    mics.push(m);
    return { level: () => m.level, take: () => new Float32Array(BLOCK).fill(m.level), close: m.close };
  },
}));

// The voice conversation's connection, for the muting tests.
type Call = { sent: Record<string, unknown>[]; handlers: VoiceConnectionHandlers };
const calls: Call[] = [];
vi.mock('../src/lib/voice-connection', () => ({
  connectVoice: async (exchange: (sdp: string) => Promise<unknown>, handlers: VoiceConnectionHandlers) => {
    await exchange('offer');
    const c: Call = { sent: [], handlers };
    calls.push(c);
    return { send: (e: Record<string, unknown>) => c.sent.push(e), setMicEnabled: () => {}, micLevel: () => 0, setGate: () => {}, close: () => {} };
  },
  micErrorWords: (e: unknown) => e,
}));

import { useDictation, DICTATION_FLUSH_MS } from '../src/stores/dictation';
import { useVoice } from '../src/stores/voice';
import { useOrchestrator } from '../src/stores/orchestrator';
import { voiceGatePick } from '../src/lib/voice';

const OWNER = Symbol('field');
const event = (c: Call, e: LiveEvent) => c.handlers.onEvent(e);
// Lets settled answers run their `then`.
const flush = () => vi.advanceTimersByTimeAsync(0);

// The operator speaks for a moment, then pauses long enough for the phrase to be cut.
async function phrase(m: Mic, level = 0.5): Promise<void> {
  m.level = level;
  await vi.advanceTimersByTimeAsync(200);
  m.level = 0;
  await vi.advanceTimersByTimeAsync(DICTATION_PAUSE_MS + 200);
}

/** The PCM samples in a sent phrase's WAV. */
function samplesSent(call: number): number {
  const wav = atob(transcribe.mock.calls[call]![0].audio);
  expect(wav.slice(0, 4)).toBe('RIFF');
  return (wav.length - 44) / 2;
}

describe('the dictation store', () => {
  let inserted: string[];

  beforeEach(() => {
    setActivePinia(createPinia());
    answers.length = 0;
    transcribe.mockReset().mockImplementation(() => {
      const a: Answer = Promise.withResolvers();
      answers.push(a);
      return a.promise;
    });
    sttWarm.mockReset().mockResolvedValue({ ok: true });
    mics.length = 0;
    calls.length = 0;
    voiceGatePick.value = 'medium';
    inserted = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('warms the recogniser, then sends each phrase with the quiet just before it', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    expect(sttWarm).toHaveBeenCalledOnce();
    expect(d.phase).toBe('live');
    const m = mics[0]!;

    await vi.advanceTimersByTimeAsync(500);
    m.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);
    expect(d.speaking).toBe(true);
    expect(d.lastSpeechAt).toBeGreaterThan(0);
    expect(transcribe).not.toHaveBeenCalled();
    m.level = 0;
    await vi.advanceTimersByTimeAsync(DICTATION_PAUSE_MS + 200);
    expect(d.speaking).toBe(false);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0]![0]).toMatchObject({ language: 'uk' });
    expect(d.transcribing).toBe(1);
    // 300 ms of pre-roll, 200 ms of speech, the 800 ms pause that ended it.
    expect(samplesSent(0)).toBe(3 * BLOCK + 2 * BLOCK + 8 * BLOCK);

    answers[0]!.resolve({ text: 'Додай кнопку.' });
    await flush();
    expect(inserted).toEqual(['Додай кнопку.']);
    expect(d.transcribing).toBe(0);
  });

  it('delivers phrases in the order they were spoken when answers come back out of order', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const m = mics[0]!;
    await phrase(m);
    await phrase(m);
    expect(transcribe).toHaveBeenCalledTimes(2);

    answers[1]!.resolve({ text: 'Друге.' });
    await flush();
    expect(inserted).toEqual([]);
    answers[0]!.resolve({ text: 'Перше.' });
    await flush();
    expect(inserted).toEqual(['Перше.', 'Друге.']);
  });

  it('an empty answer (an invented phrase the api dropped) delivers nothing and holds nothing up', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const m = mics[0]!;
    await phrase(m);
    await phrase(m);
    await phrase(m);
    answers[0]!.resolve({ text: '' });
    answers[1]!.resolve({ text: '  ' });
    answers[2]!.resolve({ text: 'Справжнє.' });
    await flush();
    expect(inserted).toEqual(['Справжнє.']);
  });

  it('a failed phrase is reported and the phrases after it still land', async () => {
    const d = useDictation();
    const notify = vi.spyOn(useOrchestrator(), 'notify');
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const m = mics[0]!;
    await phrase(m);
    await phrase(m);
    answers[1]!.resolve({ text: 'Друге.' });
    answers[0]!.reject(new Error('stt_engine_failed'));
    await flush();
    expect(notify).toHaveBeenCalledWith('dictation.phraseFailed', 'error');
    expect(inserted).toEqual(['Друге.']);
    expect(d.phase).toBe('live');
  });

  it('speech below the noise gate threshold is never sent', async () => {
    voiceGatePick.value = 'high';
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    await phrase(mics[0]!, 0.12);
    expect(transcribe).not.toHaveBeenCalled();
    await phrase(mics[0]!, 0.3);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it('stop sends the phrase being spoken, closes the microphone and waits for its text', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const m = mics[0]!;
    m.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);

    let stopped = false;
    const stopping = d.stop().then(() => (stopped = true));
    expect(transcribe).toHaveBeenCalledOnce();
    expect(m.close).toHaveBeenCalled();
    expect(d.phase).toBe('stopping');
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);

    answers[0]!.resolve({ text: 'Останнє.' });
    await stopping;
    expect(inserted).toEqual(['Останнє.']);
    expect(d.phase).toBe('idle');
  });

  it('stop in silence ends at once', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    await vi.advanceTimersByTimeAsync(300);
    await d.stop();
    expect(transcribe).not.toHaveBeenCalled();
    expect(d.phase).toBe('idle');
  });

  it('stop gives up on a phrase that never comes back', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    mics[0]!.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);
    const stopping = d.stop();
    await vi.advanceTimersByTimeAsync(DICTATION_FLUSH_MS);
    await stopping;
    expect(d.phase).toBe('idle');
    // A late answer after dictation ended lands nowhere.
    answers[0]!.resolve({ text: 'запізно' });
    await flush();
    expect(inserted).toEqual([]);
  });

  it('cancel drops unfinished phrases at once', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const m = mics[0]!;
    await phrase(m);
    m.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);
    d.cancel();
    expect(d.phase).toBe('idle');
    expect(m.close).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledOnce();
    answers[0]!.resolve({ text: 'недоказане' });
    await flush();
    expect(inserted).toEqual([]);
  });

  it('a missing model refuses to start before the microphone is opened', async () => {
    sttWarm.mockRejectedValue(Object.assign(new Error('missing'), { code: 'stt_model_missing' }));
    const d = useDictation();
    await expect(d.start(OWNER, { onText: () => {} })).rejects.toMatchObject({ code: 'stt_model_missing' });
    expect(d.phase).toBe('idle');
    expect(d.owner).toBe(null);
    expect(mics).toHaveLength(0);
  });

  it('a second owner takes over: the first one is stopped', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    const other = Symbol('other');
    await d.start(other, { onText: () => {} });
    expect(mics[0]!.close).toHaveBeenCalled();
    expect(d.owner).toBe(other);
    expect(d.phase).toBe('live');
  });

  it('a minute of silence stops a popup’s dictation with a notice', async () => {
    const d = useDictation();
    const notify = vi.spyOn(useOrchestrator(), 'notify');
    await d.start(OWNER, { onText: (t) => inserted.push(t) });
    await vi.advanceTimersByTimeAsync(DICTATION_IDLE_MS + 200);
    expect(d.phase).toBe('idle');
    expect(notify).toHaveBeenCalledWith('dictation.idleStopped', 'info');
  });

  it('an owner can ask for a longer silence (a composer)', async () => {
    const d = useDictation();
    await d.start(OWNER, { onText: (t) => inserted.push(t), idleMs: DICTATION_COMPOSER_IDLE_MS });
    await vi.advanceTimersByTimeAsync(DICTATION_IDLE_MS + 200);
    expect(d.phase).toBe('live');
    await vi.advanceTimersByTimeAsync(DICTATION_COMPOSER_IDLE_MS);
    expect(d.phase).toBe('idle');
  });

  it('mutes a running voice conversation and gives its microphone back afterwards', async () => {
    const voice = useVoice();
    await voice.start('s1');
    const call = calls[0]!;
    event(call, { type: 'session.started' });

    const d = useDictation();
    await d.start(OWNER, { onText: () => {} });
    expect(voice.muted).toBe(true);
    expect(call.sent.at(-1)).toEqual({ type: 'session.input_audio.mute' });
    d.cancel();
    expect(voice.muted).toBe(false);
    expect(call.sent.at(-1)).toEqual({ type: 'session.input_audio.unmute' });
  });

  it('leaves a conversation the operator had muted muted', async () => {
    const voice = useVoice();
    await voice.start('s1');
    const call = calls[0]!;
    event(call, { type: 'session.started' });
    voice.toggleMute();
    const before = call.sent.length;

    const d = useDictation();
    await d.start(OWNER, { onText: () => {} });
    d.cancel();
    expect(voice.muted).toBe(true);
    expect(call.sent.length).toBe(before);
  });
});
