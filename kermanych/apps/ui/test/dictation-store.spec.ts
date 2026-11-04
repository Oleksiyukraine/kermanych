// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DICTATION_IDLE_MS, DICTATION_PAUSE_MS } from '@kermanych/core';
import type { LiveEvent, VoiceConnectionHandlers } from '../src/lib/voice-connection';

// Voice dictation's store (docs/specs/2026-11-03-voice-dictation.md) with the transcription data
// channel scripted: what lands in the field and when, how it stops, and the voice conversation
// it mutes meanwhile.

const voiceDictation = vi.fn();
vi.mock('../src/lib/api', () => ({
  api: {
    voiceDictation: (...args: unknown[]) => voiceDictation(...args),
    voiceSession: () => Promise.resolve({ id: 'live_1', sdp: 'answer' }),
    models: () => Promise.resolve([]),
  },
}));
vi.mock('../src/lib/socket', () => ({ connectSocket: () => ({}) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k } }));
vi.mock('../src/stores/auth', () => ({ useAuth: () => ({ language: 'uk' }) }));

type Fake = { sent: Record<string, unknown>[]; mic: boolean[]; level: number; handlers: VoiceConnectionHandlers; close: Mock };
const conns: Fake[] = [];
vi.mock('../src/lib/voice-connection', () => ({
  connectVoice: async (exchange: (sdp: string) => Promise<unknown>, handlers: VoiceConnectionHandlers) => {
    await exchange('offer');
    const c: Fake = { sent: [], mic: [], level: 0, handlers, close: vi.fn() };
    conns.push(c);
    return { send: (e: Record<string, unknown>) => c.sent.push(e), setMicEnabled: (on: boolean) => c.mic.push(on), micLevel: () => c.level, close: c.close };
  },
  micErrorWords: (e: unknown) => e,
}));

import { useDictation, DICTATION_FLUSH_MS } from '../src/stores/dictation';
import { useVoice } from '../src/stores/voice';
import { useOrchestrator } from '../src/stores/orchestrator';

const OWNER = Symbol('field');
const commits = (c: Fake) => c.sent.filter((e) => e.type === 'input_audio_buffer.commit').length;
const event = (c: Fake, e: LiveEvent) => c.handlers.onEvent(e);

// The operator speaks for a moment, then pauses long enough for the phrase to be committed.
async function phrase(c: Fake): Promise<void> {
  c.level = 0.5;
  await vi.advanceTimersByTimeAsync(200);
  c.level = 0;
  await vi.advanceTimersByTimeAsync(DICTATION_PAUSE_MS + 200);
}

describe('the dictation store', () => {
  let inserted: string[];

  beforeEach(() => {
    setActivePinia(createPinia());
    voiceDictation.mockReset().mockResolvedValue({ sdp: 'answer' });
    conns.length = 0;
    inserted = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('shows drafts as a caption and inserts finished phrases in the order they were spoken', async () => {
    const d = useDictation();
    await d.start(OWNER, (t) => inserted.push(t));
    expect(voiceDictation).toHaveBeenCalledWith({ sdp: 'offer', languages: ['uk', 'en'] });
    const c = conns[0]!;

    event(c, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Дода' });
    event(c, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'й кнопку' });
    expect(d.caption).toBe('Додай кнопку');

    await phrase(c);
    await phrase(c);
    expect(commits(c)).toBe(2);
    event(c, { type: 'input_audio_buffer.committed', item_id: 'i1' });
    event(c, { type: 'input_audio_buffer.committed', item_id: 'i2' });
    event(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i2', transcript: 'Друге.' });
    expect(inserted).toEqual([]);
    event(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Додай кнопку.' });
    expect(inserted).toEqual(['Додай кнопку.', 'Друге.']);
    expect(d.caption).toBe('');
  });

  it('stop commits the phrase being spoken and waits for its text before closing', async () => {
    const d = useDictation();
    await d.start(OWNER, (t) => inserted.push(t));
    const c = conns[0]!;
    c.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);

    let stopped = false;
    const stopping = d.stop().then(() => (stopped = true));
    expect(commits(c)).toBe(1);
    expect(c.mic.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);

    event(c, { type: 'input_audio_buffer.committed', item_id: 'i1' });
    event(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Останнє.' });
    await stopping;
    expect(inserted).toEqual(['Останнє.']);
    expect(d.phase).toBe('idle');
    expect(c.close).toHaveBeenCalled();
  });

  it('stop gives up on a phrase that never comes back', async () => {
    const d = useDictation();
    await d.start(OWNER, (t) => inserted.push(t));
    const c = conns[0]!;
    c.level = 0.5;
    await vi.advanceTimersByTimeAsync(200);
    const stopping = d.stop();
    await vi.advanceTimersByTimeAsync(DICTATION_FLUSH_MS);
    await stopping;
    expect(d.phase).toBe('idle');
    // A late answer after the line closed lands nowhere.
    event(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'запізно' });
    expect(inserted).toEqual([]);
  });

  it('cancel drops the unfinished phrase at once', async () => {
    const d = useDictation();
    await d.start(OWNER, (t) => inserted.push(t));
    const c = conns[0]!;
    event(c, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'недо' });
    d.cancel();
    expect(d.phase).toBe('idle');
    expect(commits(c)).toBe(0);
    event(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'недоказане' });
    expect(inserted).toEqual([]);
  });

  it('a second field takes over: the first one is stopped', async () => {
    const d = useDictation();
    await d.start(OWNER, (t) => inserted.push(t));
    const other = Symbol('other');
    await d.start(other, () => {});
    expect(conns[0]!.close).toHaveBeenCalled();
    expect(d.owner).toBe(other);
    expect(d.phase).toBe('live');
  });

  it('a minute of silence stops it with a notice', async () => {
    const d = useDictation();
    const notify = vi.spyOn(useOrchestrator(), 'notify');
    await d.start(OWNER, (t) => inserted.push(t));
    await vi.advanceTimersByTimeAsync(DICTATION_IDLE_MS + 200);
    expect(d.phase).toBe('idle');
    expect(notify).toHaveBeenCalledWith('dictation.idleStopped', 'info');
  });

  it('mutes a running voice conversation and gives its microphone back afterwards', async () => {
    const voice = useVoice();
    await voice.start('s1');
    const call = conns[0]!;
    event(call, { type: 'session.started' });

    const d = useDictation();
    await d.start(OWNER, () => {});
    expect(voice.muted).toBe(true);
    expect(call.sent.at(-1)).toEqual({ type: 'session.input_audio.mute' });
    d.cancel();
    expect(voice.muted).toBe(false);
    expect(call.sent.at(-1)).toEqual({ type: 'session.input_audio.unmute' });
  });

  it('leaves a conversation the operator had muted muted', async () => {
    const voice = useVoice();
    await voice.start('s1');
    const call = conns[0]!;
    event(call, { type: 'session.started' });
    voice.toggleMute();
    const before = call.sent.length;

    const d = useDictation();
    await d.start(OWNER, () => {});
    d.cancel();
    expect(voice.muted).toBe(true);
    expect(call.sent.length).toBe(before);
  });
});
