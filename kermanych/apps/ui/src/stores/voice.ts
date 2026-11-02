// apps/ui/src/stores/voice.ts
// The one voice conversation of the app (docs/specs/2026-11-02-voice-conversation.md, decision
// 8): bound to one session from start to end, whichever page or agent the operator looks at.
// It owns the WebRTC connection (lib/voice-connection.ts) and turns GPT-Live's events into what
// the voice bar shows: the phase, who is talking, the live caption and the microphone level.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { voiceLanguage } from '@kermanych/core';
import { api } from '../lib/api';
import { connectVoice, type LiveEvent, type VoiceConnection } from '../lib/voice-connection';
import { voicePick, type VoiceBarState } from '../lib/voice';
import { locale } from '../lib/locale';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';

export type VoicePhase = 'idle' | VoiceBarState['phase'];
export type VoiceActivity = VoiceBarState['activity'];
export type VoiceCaption = NonNullable<VoiceBarState['caption']>;

// A transcript fragment this long after the previous one of the same speaker starts a new phrase.
const PHRASE_GAP_MS = 1500;
// How long after the last fragment a speaker still counts as talking.
const TALKING_MS = 1200;
// After «Завершити», how long GPT-Live gets to answer `session.close` before the line is cut.
const CLOSE_WAIT_MS = 3000;
const TICK_MS = 150;

export const useVoice = defineStore('voice', () => {
  const orchestrator = useOrchestrator();
  const auth = useAuth();

  const phase = ref<VoicePhase>('idle');
  const sessionId = ref<string | null>(null);
  const startedAt = ref<number | null>(null);
  const muted = ref(false);
  const caption = ref<VoiceCaption | null>(null);
  const micLevel = ref(0);
  const now = ref(Date.now());

  let conn: VoiceConnection | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped by every start and every finish: a connection that settles after its conversation
  // was ended (or replaced) is closed instead of installed.
  let generation = 0;
  let closing: PromiseWithResolvers<void> | null = null;
  let heardSinceDelegation = '';
  // The last fragment's arrival per speaker, for the talking state and the phrase gap.
  const lastHeardAt = ref(0);
  const lastSpokeAt = ref(0);

  const activity = computed<VoiceActivity>(() => {
    if (now.value - lastSpokeAt.value < TALKING_MS) return 'speaking';
    if (now.value - lastHeardAt.value < TALKING_MS) return 'hearing';
    const s = sessionId.value ? orchestrator.sessions.find((x) => x.id === sessionId.value) : undefined;
    return s && (s.status === 'thinking' || s.status === 'tool') ? 'agent' : 'listening';
  });

  const elapsedMs = computed(() => (startedAt.value === null ? 0 : Math.max(0, now.value - startedAt.value)));

  // The voice bar's whole state, or null while no conversation runs.
  const bar = computed<VoiceBarState | null>(() =>
    phase.value === 'idle'
      ? null
      : { phase: phase.value, activity: activity.value, caption: caption.value, micLevel: micLevel.value, muted: muted.value, elapsedMs: elapsedMs.value },
  );

  function onEvent(e: LiveEvent): void {
    switch (e.type) {
      case 'session.started':
        phase.value = 'live';
        startedAt.value = Date.now();
        break;
      case 'session.input_transcript.delta':
        appendCaption('operator', String(e.delta ?? ''));
        lastHeardAt.value = Date.now();
        heardSinceDelegation += String(e.delta ?? '');
        break;
      // STEP-1 CHECKPOINT ONLY (spec «Steps» 1): no agent behind the voice yet, so a delegation is
      // answered by echoing what was heard — it exercises recognition and Ukrainian speech end to
      // end. Replaced by the bridge to the session's agent in step 2.
      case 'session.delegation.created': {
        const d = e.delegation as { id?: string } | undefined;
        conn?.send({
          type: 'session.commentary.append',
          delegation_id: d?.id ?? null,
          content: `Test build: the agent is not connected yet. Tell the operator, word for word, what you heard them say: «${heardSinceDelegation.trim()}»`,
        });
        heardSinceDelegation = '';
        break;
      }
      case 'session.output_transcript.delta':
        appendCaption('voice', String(e.delta ?? ''));
        lastSpokeAt.value = Date.now();
        break;
      case 'session.closed':
        finish();
        break;
      case 'error': {
        const err = e.error as { message?: string } | undefined;
        orchestrator.notify(err?.message ?? 'GPT-Live error', 'error');
        break;
      }
    }
  }

  function appendCaption(who: VoiceCaption['who'], delta: string): void {
    const last = who === 'operator' ? lastHeardAt.value : lastSpokeAt.value;
    const fresh = !caption.value || caption.value.who !== who || Date.now() - last > PHRASE_GAP_MS;
    caption.value = { who, text: fresh ? delta.trimStart() : caption.value!.text + delta };
  }

  async function start(id: string): Promise<void> {
    if (phase.value !== 'idle') await end();
    phase.value = 'connecting';
    sessionId.value = id;
    muted.value = false;
    caption.value = null;
    const language = voiceLanguage(auth.language, locale.value);
    const mine = ++generation;
    let opened: VoiceConnection;
    try {
      opened = await connectVoice((sdp) => api.voiceSession({ sdp, voice: voicePick.value, language }), {
        onEvent: (e) => mine === generation && onEvent(e),
        onDrop: () => {
          if (mine !== generation) return;
          orchestrator.notify(globalTr.t('voice.dropped'), 'error');
          finish();
        },
      });
    } catch (e) {
      if (mine === generation) finish();
      // The browser's own words for a refused or missing microphone are English and technical.
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'NotFoundError'))
        throw new Error(globalTr.t(e.name === 'NotAllowedError' ? 'voice.micDenied' : 'voice.micMissing'));
      throw e;
    }
    // «Завершити» pressed (or another conversation started) while this one was connecting.
    if (mine !== generation) return opened.close();
    conn = opened;
    ticker = setInterval(() => {
      now.value = Date.now();
      micLevel.value = conn && !muted.value ? conn.micLevel() : 0;
    }, TICK_MS);
  }

  // «Завершити»: GPT-Live is asked to close so it can settle its usage; the line is cut anyway
  // if it does not answer in time. Never touches the agent's running turn (decision 8).
  async function end(): Promise<void> {
    if (phase.value === 'idle') return;
    if (!conn) return finish();
    if (phase.value !== 'ending') {
      phase.value = 'ending';
      conn.send({ type: 'session.close' });
      closing = Promise.withResolvers<void>();
      closeTimer = setTimeout(finish, CLOSE_WAIT_MS);
    }
    await closing?.promise;
  }

  function toggleMute(): void {
    if (!conn) return;
    muted.value = !muted.value;
    conn.setMicEnabled(!muted.value);
    conn.send({ type: muted.value ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }

  function finish(): void {
    generation++;
    clearInterval(ticker);
    clearTimeout(closeTimer);
    conn?.close();
    conn = null;
    phase.value = 'idle';
    sessionId.value = null;
    startedAt.value = null;
    caption.value = null;
    micLevel.value = 0;
    muted.value = false;
    closing?.resolve();
    closing = null;
  }

  return { phase, sessionId, startedAt, muted, caption, micLevel, activity, elapsedMs, bar, start, end, toggleMute };
});
