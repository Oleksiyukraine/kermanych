// apps/ui/src/stores/dictation.ts
// The one voice dictation of the app (docs/specs/2026-11-03-voice-dictation.md): the operator
// speaks a task description and OpenAI's streaming transcription (gpt-live-transcribe) writes it
// into the field that started it. The WebRTC half is the voice conversation's
// (lib/voice-connection.ts); the decisions — when a phrase ends, the order finished phrases land
// in — are core's pure dictation.ts. A field talks to this store through
// composables/useDictationField.ts; it hands over an owner token and an `insert` callback.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  dictationLanguages,
  emptySegments,
  segmentCommitted,
  segmentSettled,
  segmentsDone,
  vadStart,
  vadStep,
  type DictationSegments,
  type VadState,
} from '@kermanych/core';
import { api } from '../lib/api';
import { connectVoice, micErrorWords, type LiveEvent, type VoiceConnection } from '../lib/voice-connection';
import { locale } from '../lib/locale';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { useVoice } from './voice';

export type DictationPhase = 'idle' | 'connecting' | 'live' | 'stopping';

// Decision 6.1: after «stop» the last phrase gets this long to come back as text.
export const DICTATION_FLUSH_MS = 5000;
const TICK_MS = 100;

export const useDictation = defineStore('dictation', () => {
  const orchestrator = useOrchestrator();
  const auth = useAuth();
  const voice = useVoice();

  const phase = ref<DictationPhase>('idle');
  const owner = ref<symbol | null>(null);
  const micLevel = ref(0);
  // Draft text per transcription item, in the order the items first spoke (decision 4).
  const drafts = ref<{ id: string; text: string }[]>([]);
  const caption = computed(() => drafts.value.map((d) => d.text).join(' ').trim());

  let conn: VoiceConnection | null = null;
  let insert: ((text: string) => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping: PromiseWithResolvers<void> | null = null;
  // Bumped by every start and every finish: a connection or an event that arrives for a
  // dictation already ended does nothing.
  let generation = 0;
  let vad: VadState = vadStart(0);
  let segments: DictationSegments = emptySegments();
  // Commits sent whose `input_audio_buffer.committed` has not come back yet.
  let awaitingCommits = 0;

  function commit(): void {
    if (!conn) return;
    awaitingCommits++;
    conn.send({ type: 'input_audio_buffer.commit' });
  }

  // After «stop», the line closes once every commit came back and every phrase has its text.
  function finishIfFlushed(): void {
    if (phase.value === 'stopping' && awaitingCommits === 0 && segmentsDone(segments)) finish();
  }

  function settle(itemId: string, transcript: string | null): void {
    const out = segmentSettled(segments, itemId, transcript);
    segments = out.segments;
    drafts.value = drafts.value.filter((d) => d.id !== itemId);
    for (const text of out.release) insert?.(text);
    finishIfFlushed();
  }

  function onEvent(e: LiveEvent): void {
    const itemId = typeof e.item_id === 'string' ? e.item_id : '';
    switch (e.type) {
      case 'input_audio_buffer.committed':
        awaitingCommits = Math.max(0, awaitingCommits - 1);
        if (itemId) segments = segmentCommitted(segments, itemId);
        finishIfFlushed();
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String(e.delta ?? '');
        const draft = drafts.value.find((d) => d.id === itemId);
        if (draft) draft.text += delta;
        else drafts.value.push({ id: itemId, text: delta });
        // Words coming back are speech even when the meter missed it: no silence stop meanwhile.
        vad = { ...vad, lastSpeechAt: Date.now() };
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        settle(itemId, String(e.transcript ?? ''));
        break;
      case 'conversation.item.input_audio_transcription.failed':
        orchestrator.notify(globalTr.t('dictation.phraseFailed'), 'error');
        settle(itemId, null);
        break;
      case 'error': {
        const err = e.error as { code?: string; message?: string } | undefined;
        // A commit that found no audio is the VAD's guess gone wrong, not the operator's problem.
        if (err?.code === 'input_audio_buffer_commit_empty') {
          awaitingCommits = Math.max(0, awaitingCommits - 1);
          finishIfFlushed();
          break;
        }
        orchestrator.notify(globalTr.t('dictation.error', { error: err?.message ?? '' }), 'error');
        break;
      }
    }
  }

  // The meter decides when a phrase ended (gpt-live-transcribe has no server VAD) and when the
  // operator has been silent for too long (decision 6.4).
  function tick(): void {
    if (!conn || phase.value !== 'live') return;
    const level = conn.micLevel();
    micLevel.value = level;
    const step = vadStep(vad, level, Date.now());
    vad = step.state;
    if (step.commit) commit();
    if (step.idle) {
      orchestrator.notify(globalTr.t('dictation.idleStopped'), 'info');
      void stop();
    }
  }

  /** Starts dictating into `who`'s field; another field's dictation is stopped first (decision 6). */
  async function start(who: symbol, onText: (text: string) => void): Promise<void> {
    if (phase.value !== 'idle') await stop();
    const mine = ++generation;
    phase.value = 'connecting';
    owner.value = who;
    insert = onText;
    drafts.value = [];
    segments = emptySegments();
    awaitingCommits = 0;
    // Decision 5: a running voice conversation must not hear the description.
    voice.holdMic();
    const languages = dictationLanguages(auth.language, locale.value);
    let opened: VoiceConnection;
    try {
      opened = await connectVoice((sdp) => api.voiceDictation({ sdp, languages }), {
        onEvent: (e) => mine === generation && onEvent(e),
        onDrop: () => {
          if (mine !== generation) return;
          orchestrator.notify(globalTr.t('dictation.dropped'), 'error');
          finish();
        },
      });
    } catch (e) {
      if (mine === generation) finish();
      throw micErrorWords(e, { denied: globalTr.t('voice.micDenied'), missing: globalTr.t('voice.micMissing') });
    }
    // Stopped, cancelled or replaced while connecting.
    if (mine !== generation) return opened.close();
    conn = opened;
    phase.value = 'live';
    vad = vadStart(Date.now());
    ticker = setInterval(tick, TICK_MS);
  }

  /**
   * Decision 6.1: the phrase being spoken is committed and its text awaited (at most
   * DICTATION_FLUSH_MS), then the line is closed. Resolves once everything that came back is in
   * the field.
   */
  async function stop(): Promise<void> {
    if (phase.value === 'idle') return;
    if (phase.value === 'connecting' || !conn) return finish();
    if (phase.value === 'live') {
      phase.value = 'stopping';
      micLevel.value = 0;
      // Draft text not yet committed counts even when the meter never saw speech.
      if (vad.pending || drafts.value.some((d) => d.text.trim() && !segments.order.includes(d.id))) commit();
      // Nothing more is said into this dictation.
      conn.setMicEnabled(false);
      stopping = Promise.withResolvers<void>();
      flushTimer = setTimeout(finish, DICTATION_FLUSH_MS);
      finishIfFlushed();
    }
    await stopping?.promise;
  }

  /** Decision 6.3: the popup closed — no waiting, an unfinished phrase is lost. */
  function cancel(): void {
    if (phase.value !== 'idle') finish();
  }

  function finish(): void {
    generation++;
    clearInterval(ticker);
    clearTimeout(flushTimer);
    conn?.close();
    conn = null;
    insert = null;
    phase.value = 'idle';
    owner.value = null;
    micLevel.value = 0;
    drafts.value = [];
    segments = emptySegments();
    awaitingCommits = 0;
    voice.releaseMic();
    stopping?.resolve();
    stopping = null;
  }

  // A voice conversation started mid-dictation is muted as well (decision 5).
  watch(
    () => voice.phase,
    (p) => {
      if (p === 'live' && phase.value !== 'idle') voice.holdMic();
    },
  );

  return { phase, owner, micLevel, caption, start, stop, cancel };
});
