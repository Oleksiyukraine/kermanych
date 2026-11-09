// apps/ui/src/stores/voice.ts
// The one voice conversation of the app (docs/specs/2026-11-02-voice-conversation.md): bound to
// one session from start to end, whichever page or agent the operator looks at (decision 8). It
// owns the WebRTC connection (lib/voice-connection.ts) and wires GPT-Live to the session's agent
// (decision 10): a delegation becomes a message to the agent — or the answer to its pending
// question — and the end of the agent's turn becomes what GPT-Live retells. What to do is decided
// by core's pure voice-bridge.ts; this store only performs it.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  PROGRESS_EVERY_MS,
  delegationAction,
  describeUiRequest,
  finalReply,
  progressNote,
  shouldHangUp,
  takeUtterance,
  toCommentaryChunks,
  voiceLanguage,
  type HeardFragment,
  type Session,
} from '@kermanych/core';
import { api } from '../lib/api';
import { connectVoice, micErrorWords, type LiveEvent, type VoiceConnection } from '../lib/voice-connection';
import { voiceGatePick, voicePick, type VoiceBarState } from '../lib/voice';
import { VOICE_GATE_LEVELS } from '../lib/voice-gate';
import { locale } from '../lib/locale';
import { nextMode } from '../lib/message-mode';
import { globalTr } from '../boot/i18n';
import { errorText } from '../composables/useAsyncAction';
import { useHeldTranscript } from '../composables/useHeldTranscript';
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
// The last words of a phrase can arrive after the delegation that ends it.
const DELEGATION_GRACE_MS = 700;
// After an agent error is said, the conversation ends (decision 8) — once GPT-Live had time to say it.
const ERROR_END_MS = 8000;
const TICK_MS = 150;

const ASKS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

function agentBusy(s: Session | undefined): boolean {
  return !!s && (s.status === 'thinking' || s.status === 'tool' || s.status === 'queued');
}

export const useVoice = defineStore('voice', () => {
  const orchestrator = useOrchestrator();
  const auth = useAuth();

  const phase = ref<VoicePhase>('idle');
  const sessionId = ref<string | null>(null);
  const startedAt = ref<number | null>(null);
  const muted = ref(false);
  const caption = ref<VoiceCaption | null>(null);
  const micLevel = ref(0);
  // Whether the noise gate lets the microphone through to GPT-Live right now.
  const gateOpen = ref(false);
  const gate = computed(() => VOICE_GATE_LEVELS[voiceGatePick.value]);
  const now = ref(Date.now());
  // The last fragment's arrival per speaker, for the talking state and the phrase gap.
  const lastHeardAt = ref(0);
  const lastSpokeAt = ref(0);

  let conn: VoiceConnection | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped by every start and every finish: a connection, a delegation or a timer that settles
  // after its conversation was ended (or replaced) does nothing.
  let generation = 0;
  let closing: PromiseWithResolvers<void> | null = null;

  // ── bridge state ──
  let heard: HeardFragment[] = [];
  // Anything that keeps the conversation alive: GPT-Live talking, a hand-off, the agent finishing a turn.
  let lastActivityAt = 0;
  // The delegation whose message started the agent's current turn: its results go back under it.
  let turnDelegation: string | null = null;
  // What was already said, so a re-read transcript or a repeated status never repeats it.
  // By text, not id: a transcript re-read (↻, a resume) hands the same reply a new id.
  let spokenReplyText: string | undefined;
  let spokenRequestId: string | undefined;
  // When this conversation began. A reply older than it is history, even when a re-read of the
  // transcript gives it a new id.
  let since = 0;
  let lastProgressAt = 0;
  let seenEntries = 0;

  const bound = computed(() => (sessionId.value ? orchestrator.sessions.find((x) => x.id === sessionId.value) : undefined));
  // The bridge reads the bound session's transcript for the agent's replies whichever page the
  // operator looks at (decision 8), so it stays resident for the whole conversation.
  useHeldTranscript(() => sessionId.value);

  const activity = computed<VoiceActivity>(() => {
    if (now.value - lastSpokeAt.value < TALKING_MS) return 'speaking';
    if (now.value - lastHeardAt.value < TALKING_MS) return 'hearing';
    return agentBusy(bound.value) ? 'agent' : 'listening';
  });

  const elapsedMs = computed(() => (startedAt.value === null ? 0 : Math.max(0, now.value - startedAt.value)));

  // The voice bar's whole state, or null while no conversation runs.
  const bar = computed<VoiceBarState | null>(() =>
    phase.value === 'idle'
      ? null
      : {
          phase: phase.value,
          activity: activity.value,
          caption: caption.value,
          micLevel: micLevel.value,
          gate: gate.value,
          gateOpen: gateOpen.value,
          muted: muted.value,
          elapsedMs: elapsedMs.value,
        },
  );

  const live = () => phase.value === 'live' && !!conn;
  const commentary = (delegationId: string | null, content: string) =>
    conn?.send({ type: 'session.commentary.append', delegation_id: delegationId, content });
  const thinking = (delegationId: string | null, content: string) =>
    conn?.send({ type: 'session.thinking.append', delegation_id: delegationId, content });

  function onEvent(e: LiveEvent): void {
    switch (e.type) {
      case 'session.started':
        phase.value = 'live';
        startedAt.value = Date.now();
        lastActivityAt = Date.now();
        // A question the agent was already waiting on when the conversation began is said at once.
        speakPending();
        break;
      case 'session.input_transcript.delta': {
        const text = String(e.delta ?? '');
        appendCaption('operator', text);
        // Not activity for the hang-up: the input transcript hears a TV as readily as the operator
        // (docs/specs/2026-11-04-voice-background-noise.md, decision 5).
        lastHeardAt.value = Date.now();
        const startMs = Number(e.start_ms ?? 0);
        heard.push({ text, startMs, endMs: Number(e.end_ms ?? startMs) });
        break;
      }
      case 'session.output_transcript.delta':
        appendCaption('voice', String(e.delta ?? ''));
        lastSpokeAt.value = lastActivityAt = Date.now();
        break;
      case 'session.delegation.created': {
        const id = (e.delegation as { id?: string } | undefined)?.id ?? null;
        const offset = typeof e.offset_ms === 'number' ? e.offset_ms : Number.POSITIVE_INFINITY;
        lastActivityAt = Date.now();
        const mine = generation;
        setTimeout(() => mine === generation && void onDelegation(id, offset), DELEGATION_GRACE_MS);
        break;
      }
      case 'session.closed':
        finish();
        break;
      case 'error': {
        const err = e.error as { message?: string } | undefined;
        orchestrator.notify(globalTr.t('voice.liveError', { error: err?.message ?? '' }), 'error');
        break;
      }
    }
  }

  function appendCaption(who: VoiceCaption['who'], delta: string): void {
    const last = who === 'operator' ? lastHeardAt.value : lastSpokeAt.value;
    const fresh = !caption.value || caption.value.who !== who || Date.now() - last > PHRASE_GAP_MS;
    caption.value = { who, text: fresh ? delta.trimStart() : caption.value!.text + delta };
  }

  // GPT-Live asked for the agent (decision 6): the operator's words since the previous
  // delegation go to the agent as a message, or answer its pending question (decision 7).
  async function onDelegation(delegationId: string | null, offsetMs: number): Promise<void> {
    const s = bound.value;
    if (!s || !live()) return;
    const { text, rest } = takeUtterance(heard, offsetMs);
    heard = rest;
    const action = delegationAction(text, s.pendingUiRequest);
    try {
      if (action.kind === 'askAgain') commentary(delegationId, action.commentary);
      else if (action.kind === 'answer') {
        await orchestrator.answerUi(s.id, action.response);
        turnDelegation = delegationId;
        thinking(delegationId, 'The answer went to the agent; it continues.');
      } else {
        turnDelegation = delegationId;
        await orchestrator.sendMessage(s.id, action.text, nextMode(s, orchestrator.transcripts[s.id] ?? []), [], { voice: true });
        thinking(delegationId, 'The request went to the agent; it is working on it. Its answer will follow.');
      }
    } catch (e) {
      commentary(delegationId, `Delivering this to the agent failed: ${errorText(e)}. Tell the operator.`);
    }
  }

  // The agent's finished reply, then its pending question — each said once.
  function speakPending(): void {
    const s = bound.value;
    if (!s || !live() || agentBusy(s)) return;
    const reply = finalReply(orchestrator.transcripts[s.id] ?? []);
    if (reply && reply.at >= since && reply.text !== spokenReplyText) {
      spokenReplyText = reply.text;
      for (const chunk of toCommentaryChunks(reply.text)) commentary(turnDelegation, chunk);
    }
    const req = s.pendingUiRequest;
    if (req && ASKS[req.method] && req.id !== spokenRequestId) {
      spokenRequestId = req.id;
      commentary(turnDelegation, describeUiRequest(req));
    }
  }

  // Synchronous watchers: the bridge acts on transitions, and a status that passes thinking →
  // done between two flushes must still read as a turn that ended.
  watch(
    () => bound.value?.status,
    (next, prev) => {
      if (phase.value === 'idle' || !sessionId.value) return;
      const s = bound.value;
      if (!s) {
        orchestrator.notify(globalTr.t('voice.sessionGone'), 'info');
        void end();
        return;
      }
      if (!live()) return;
      if (next === 'error') {
        commentary(turnDelegation, `The agent stopped with an error${s.error ? `: ${s.error}` : ''}. The voice conversation ends now; tell the operator.`);
        const mine = generation;
        errorTimer = setTimeout(() => mine === generation && void end(), ERROR_END_MS);
        return;
      }
      if (next === 'queued' && prev !== 'queued') thinking(turnDelegation, 'The agent waits for a free agent slot before it starts.');
      if (!agentBusy(s)) {
        lastActivityAt = Date.now();
        speakPending();
      }
    },
    { flush: 'sync' },
  );
  watch(() => bound.value?.pendingUiRequest?.id, () => speakPending(), { flush: 'sync' });
  watch(
    () => bound.value?.archived,
    (archived) => {
      if (archived && phase.value !== 'idle') {
        orchestrator.notify(globalTr.t('voice.sessionGone'), 'info');
        void end();
      }
    },
    { flush: 'sync' },
  );
  // Silent progress while the agent works, at most every PROGRESS_EVERY_MS (decision 5: GPT-Live
  // can answer «what is it doing?» from it without saying it unasked). A reply that lands after
  // the status already settled is said from here.
  watch(
    () => (sessionId.value ? orchestrator.transcripts[sessionId.value]?.length ?? 0 : 0),
    (len) => {
      const s = bound.value;
      const entries = s ? orchestrator.transcripts[s.id] ?? [] : [];
      const fresh = entries.slice(Math.min(seenEntries, len));
      seenEntries = len;
      if (!live()) return;
      if (!agentBusy(s)) return speakPending();
      if (Date.now() - lastProgressAt < PROGRESS_EVERY_MS) return;
      const note = fresh.map(progressNote).filter((n): n is string => n !== null).at(-1);
      if (!note) return;
      lastProgressAt = Date.now();
      thinking(turnDelegation, note);
    },
    { flush: 'sync' },
  );

  // The threshold picked in Settings → «Голос» reaches a running conversation at once.
  watch(gate, (threshold) => conn?.setGate(threshold));

  async function start(id: string): Promise<void> {
    if (phase.value !== 'idle') await end();
    phase.value = 'connecting';
    sessionId.value = id;
    muted.value = false;
    caption.value = null;
    heard = [];
    turnDelegation = null;
    lastProgressAt = 0;
    // What is already on screen is not news: only replies that arrive from now on are said.
    const history = orchestrator.transcripts[id] ?? [];
    since = Date.now();
    spokenReplyText = undefined;
    spokenRequestId = undefined;
    seenEntries = history.length;
    const language = voiceLanguage(auth.language, locale.value);
    const mine = ++generation;
    let opened: VoiceConnection;
    try {
      // Always with the gate, «off» included: switching it on mid-conversation then just works.
      opened = await connectVoice(
        (sdp) => api.voiceSession({ sdp, voice: voicePick.value, language }),
        {
          onEvent: (e) => mine === generation && onEvent(e),
          onDrop: () => {
            if (mine !== generation) return;
            orchestrator.notify(globalTr.t('voice.dropped'), 'error');
            finish();
          },
          onGate: (open) => {
            if (mine === generation) gateOpen.value = open;
          },
        },
        { gate: gate.value },
      );
    } catch (e) {
      if (mine === generation) finish();
      throw micErrorWords(e, { denied: globalTr.t('voice.micDenied'), missing: globalTr.t('voice.micMissing') });
    }
    // «Завершити» pressed (or another conversation started) while this one was connecting.
    if (mine !== generation) return opened.close();
    conn = opened;
    ticker = setInterval(() => {
      now.value = Date.now();
      micLevel.value = conn && !muted.value ? conn.micLevel() : 0;
      if (live() && shouldHangUp(lastActivityAt, agentBusy(bound.value), now.value)) {
        orchestrator.notify(globalTr.t('voice.idleEnded'), 'info');
        void end();
      }
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

  function setMuted(on: boolean): void {
    if (!conn) return;
    muted.value = on;
    conn.setMicEnabled(!on);
    conn.send({ type: on ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }

  function toggleMute(): void {
    held = false;
    setMuted(!muted.value);
  }

  // Voice dictation (docs/specs/2026-11-03-voice-dictation.md, decision 5): while a task
  // description is dictated GPT-Live must not hear it, or it would hand it to the agent. The
  // conversation is muted as 🔇 does and unmuted afterwards — unless the operator had muted it.
  let held = false;
  function holdMic(): void {
    if (!conn || muted.value) return;
    held = true;
    setMuted(true);
  }
  function releaseMic(): void {
    if (!held) return;
    held = false;
    setMuted(false);
  }

  function finish(): void {
    generation++;
    clearInterval(ticker);
    clearTimeout(closeTimer);
    clearTimeout(errorTimer);
    conn?.close();
    conn = null;
    phase.value = 'idle';
    sessionId.value = null;
    startedAt.value = null;
    caption.value = null;
    micLevel.value = 0;
    gateOpen.value = false;
    muted.value = false;
    held = false;
    heard = [];
    closing?.resolve();
    closing = null;
  }

  return { phase, sessionId, startedAt, muted, caption, micLevel, activity, elapsedMs, bar, start, end, toggleMute, holdMic, releaseMic };
});
