// apps/ui/src/stores/dictation.ts
// The one voice dictation of the app (docs/specs/2026-11-14-local-voice-dictation.md; the first,
// OpenAI-based version was docs/specs/2026-11-03-voice-dictation.md): the operator speaks and the
// local recogniser on this machine writes each phrase into whoever started it — a task popup's
// field (composables/useDictationField.ts) or a composer. The microphone is lib/voice-capture.ts;
// the decisions — when a phrase ends, the order finished phrases land in — are core's pure
// dictation.ts. An owner hands over a token and an `onText` callback.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  DICTATION_IDLE_MS,
  STT_MAX_WAV_BYTES,
  STT_SAMPLE_RATE,
  dictationLanguage,
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
import { openCapture, type VoiceCapture } from '../lib/voice-capture';
import { micErrorWords } from '../lib/voice-connection';
import { voiceGatePick } from '../lib/voice';
import { VOICE_GATE_LEVELS } from '../lib/voice-gate';
import { encodeWav, toBase64 } from '../lib/wav';
import { locale } from '../lib/locale';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { useVoice } from './voice';

/** `starting`: the recogniser is being warmed up and the microphone opened. */
export type DictationPhase = 'idle' | 'starting' | 'live' | 'stopping';

export type DictationOptions = {
  /** One finished phrase's text, non-empty, in the order the phrases were spoken. */
  onText: (text: string) => void;
  /** The silence that stops dictation: a popup's minute by default, a composer's 10 minutes (decision 14). */
  idleMs?: number;
};

// After «stop» the phrases still being recognised get this long to come back as text.
export const DICTATION_FLUSH_MS = 5000;
const TICK_MS = 100;
// The VAD notices speech one tick late, and the first syllable is often below its level: the
// phrase keeps this much audio from before the moment speech was heard.
const PREROLL_SAMPLES = Math.round(STT_SAMPLE_RATE * 0.3);
// The api's cap on one WAV (16-bit samples after the 44-byte header): a monologue without a pause
// is cut here and goes on as the next phrase.
const MAX_PHRASE_SAMPLES = (STT_MAX_WAV_BYTES - 44) / 2;

function joined(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const useDictation = defineStore('dictation', () => {
  const orchestrator = useOrchestrator();
  const auth = useAuth();
  const voice = useVoice();

  const phase = ref<DictationPhase>('idle');
  const owner = ref<symbol | null>(null);
  const micLevel = ref(0);
  /** Phrases sent to the recogniser whose text has not come back yet. */
  const transcribing = ref(0);
  /** A phrase is being spoken: speech was heard since the last phrase was cut (decision 6's «слухаю…»). */
  const speaking = ref(false);
  /** When speech was last above the level, ms; 0 before any. A composer's send countdown starts here. */
  const lastSpeechAt = ref(0);

  let capture: VoiceCapture | null = null;
  let onText: ((text: string) => void) | null = null;
  let idleMs = DICTATION_IDLE_MS;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping: PromiseWithResolvers<void> | null = null;
  // Bumped by every start and every finish: a capture or a transcription that arrives for a
  // dictation already ended does nothing.
  let generation = 0;
  let vad: VadState = vadStart(0);
  let segments: DictationSegments = emptySegments();
  let phraseNo = 0;
  // The audio of the phrase being spoken, and the quiet just before it.
  let phrase: Float32Array[] = [];
  let phraseSamples = 0;
  let preroll = new Float32Array(0);

  // After «stop», dictation ends once every sent phrase has its text.
  function finishIfFlushed(): void {
    if (phase.value === 'stopping' && segmentsDone(segments)) finish();
  }

  function settle(id: string, text: string | null): void {
    transcribing.value = Math.max(0, transcribing.value - 1);
    const out = segmentSettled(segments, id, text);
    segments = out.segments;
    for (const t of out.release) onText?.(t);
    finishIfFlushed();
  }

  // Decision 10: the phrase goes to the local recogniser as a 16 kHz mono WAV. Answers may come
  // back out of order; the segments release them in speaking order.
  function send(): void {
    const samples = joined(phrase);
    phrase = [];
    phraseSamples = 0;
    if (!samples.length) return;
    const id = `p${++phraseNo}`;
    const mine = generation;
    segments = segmentCommitted(segments, id);
    transcribing.value++;
    api
      .transcribe({ audio: toBase64(encodeWav(samples, STT_SAMPLE_RATE)), language: dictationLanguage(auth.language, locale.value) })
      .then(
        // The api already dropped the recogniser's inventions (decision 11) as "".
        ({ text }) => mine === generation && settle(id, text.trim()),
        () => {
          if (mine !== generation) return;
          orchestrator.notify(globalTr.t('dictation.phraseFailed'), 'error');
          settle(id, null);
        },
      );
  }

  // The meter decides when a phrase ended and when the operator has been silent for too long.
  function tick(): void {
    if (!capture || phase.value !== 'live') return;
    const now = Date.now();
    const level = capture.level();
    const fresh = capture.take();
    micLevel.value = level;
    const was = vad.pending;
    // Decision 10: the noise gate's threshold applies to dictation too — a phrase that never
    // crossed it is never sent.
    const step = vadStep(vad, level, now, { speechLevel: VOICE_GATE_LEVELS[voiceGatePick.value], idleMs });
    vad = step.state;
    if (vad.pending && vad.lastSpeechAt === now) lastSpeechAt.value = now;
    if (was) {
      // Speech, or the pause after it: the pause ends the phrase's audio.
      phrase.push(fresh);
      phraseSamples += fresh.length;
    } else if (vad.pending) {
      phrase = [preroll, fresh];
      phraseSamples = preroll.length + fresh.length;
      preroll = new Float32Array(0);
    } else {
      const quiet = joined([preroll, fresh]);
      preroll = quiet.slice(Math.max(0, quiet.length - PREROLL_SAMPLES));
    }
    speaking.value = vad.pending;
    if (step.commit || phraseSamples >= MAX_PHRASE_SAMPLES) send();
    if (step.idle) {
      orchestrator.notify(globalTr.t('dictation.idleStopped', { minutes: Math.round(idleMs / 60_000) }), 'info');
      void stop();
    }
  }

  /** Starts dictating for `who`; another owner's dictation is stopped first (one per app). */
  async function start(who: symbol, opts: DictationOptions): Promise<void> {
    if (phase.value !== 'idle') await stop();
    const mine = ++generation;
    phase.value = 'starting';
    owner.value = who;
    onText = opts.onText;
    idleMs = opts.idleMs ?? DICTATION_IDLE_MS;
    // Decision 14: a running voice conversation must not hear what is dictated.
    voice.holdMic();
    let opened: VoiceCapture;
    try {
      // Decision 9: the model loads while the first phrase is spoken. A missing model refuses
      // here, before the microphone is asked for.
      await api.sttWarm();
      if (mine !== generation) return;
      opened = await openCapture();
    } catch (e) {
      if (mine === generation) finish();
      throw micErrorWords(e, { denied: globalTr.t('voice.micDenied'), missing: globalTr.t('voice.micMissing') });
    }
    // Stopped, cancelled or replaced while starting.
    if (mine !== generation) return opened.close();
    capture = opened;
    phase.value = 'live';
    vad = vadStart(Date.now());
    ticker = setInterval(tick, TICK_MS);
  }

  /**
   * The phrase being spoken is cut and sent, the microphone closes, and every sent phrase's text
   * is awaited (at most DICTATION_FLUSH_MS). Resolves once everything that came back was delivered.
   */
  async function stop(): Promise<void> {
    if (phase.value === 'starting') return finish();
    if (phase.value === 'live' && capture) {
      phase.value = 'stopping';
      clearInterval(ticker);
      const fresh = capture.take();
      if (vad.pending) {
        phrase.push(fresh);
        send();
      }
      capture.close();
      capture = null;
      micLevel.value = 0;
      speaking.value = false;
      stopping = Promise.withResolvers<void>();
      flushTimer = setTimeout(finish, DICTATION_FLUSH_MS);
      finishIfFlushed();
    }
    await stopping?.promise;
  }

  /** The owner went away (a popup closed): no waiting, unfinished phrases are lost. */
  function cancel(): void {
    if (phase.value !== 'idle') finish();
  }

  function finish(): void {
    generation++;
    clearInterval(ticker);
    clearTimeout(flushTimer);
    capture?.close();
    capture = null;
    onText = null;
    phase.value = 'idle';
    owner.value = null;
    micLevel.value = 0;
    transcribing.value = 0;
    speaking.value = false;
    lastSpeechAt.value = 0;
    segments = emptySegments();
    phrase = [];
    phraseSamples = 0;
    preroll = new Float32Array(0);
    voice.releaseMic();
    stopping?.resolve();
    stopping = null;
  }

  // A voice conversation started mid-dictation is muted as well.
  watch(
    () => voice.phase,
    (p) => {
      if (p === 'live' && phase.value !== 'idle') voice.holdMic();
    },
  );

  return { phase, owner, micLevel, transcribing, speaking, lastSpeechAt, start, stop, cancel };
});
