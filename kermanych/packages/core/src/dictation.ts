import { isAgentLanguage, type AgentLanguage } from "./language";

// Voice dictation («Диктування», docs/specs/2026-11-03-voice-dictation.md): the operator speaks a
// task description and OpenAI's streaming transcription writes it into the field. This file holds
// what the api and the ui must agree on (the model, the session, the language hints) and the
// pure decisions the ui store performs: when a phrase ends, how its text joins the field, and in
// which order finished phrases are released.

export const DICTATION_MODEL = "gpt-live-transcribe";

// Decision 8: fixed context for the recogniser. Technical names are spoken in English inside
// Ukrainian speech, and saying so keeps them from being transliterated.
export const DICTATION_PROMPT =
  "A software task description dictated for a developer. File, library, command and API names are spoken in English.";

// The agent language → the code the Realtime API accepts in `languages`. An ASD-STE100 level is
// English; Chinese needs its regional form.
const LANGUAGE_CODES: Record<AgentLanguage, string> = {
  uk: "uk",
  en: "en",
  "en-ste": "en",
  "en-ste-80": "en",
  "en-ste-60": "en",
  de: "de",
  es: "es",
  fr: "fr",
  pl: "pl",
  it: "it",
  pt: "pt",
  ja: "ja",
  zh: "zh-cn",
};

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(LANGUAGE_CODES));

// The operator speaks the agent's language (falling back to the ui locale, like the voice
// conversation), with English technical terms in it.
export function dictationLanguages(agentLanguage: unknown, uiLocale: "uk" | "en"): string[] {
  const main = isAgentLanguage(agentLanguage) ? LANGUAGE_CODES[agentLanguage] : uiLocale;
  return main === "en" ? ["en"] : [main, "en"];
}

/** The api's guard: only what `dictationLanguages` can produce reaches OpenAI. */
export function isDictationLanguages(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 2 &&
    v.every((code) => typeof code === "string" && KNOWN_CODES.has(code)) &&
    new Set(v).size === v.length
  );
}

/** The `session` of a transcription call (POST /v1/realtime/calls). */
export function dictationSession(languages: string[]): Record<string, unknown> {
  return {
    type: "transcription",
    audio: {
      input: {
        transcription: { model: DICTATION_MODEL, prompt: DICTATION_PROMPT, languages, delay: "medium" },
        // gpt-live-transcribe has no server VAD: the window commits each phrase itself.
        turn_detection: null,
      },
    },
  };
}

// ── client-side VAD ──
// The mic level is the voice connection's meter (0…1, normal speech fills most of it).
export const DICTATION_SPEECH_LEVEL = 0.1;
// A pause this long after speech ends the phrase: it is committed and transcribed.
export const DICTATION_PAUSE_MS = 800;
// Decision 6.4: this long without speech stops dictation (the billing guard).
export const DICTATION_IDLE_MS = 60_000;

export type VadState = {
  /** When speech was last above the level (or when dictation started). */
  lastSpeechAt: number;
  /** Speech was heard since the last commit. */
  pending: boolean;
};

export function vadStart(now: number): VadState {
  return { lastSpeechAt: now, pending: false };
}

export function vadStep(state: VadState, level: number, now: number): { state: VadState; commit: boolean; idle: boolean } {
  if (level >= DICTATION_SPEECH_LEVEL) return { state: { lastSpeechAt: now, pending: true }, commit: false, idle: false };
  const quiet = now - state.lastSpeechAt;
  if (state.pending && quiet >= DICTATION_PAUSE_MS) return { state: { ...state, pending: false }, commit: true, idle: false };
  return { state, commit: false, idle: quiet >= DICTATION_IDLE_MS };
}

// ── inserting a phrase ──

/**
 * Decision 4: the phrase lands at the caret (over a selection, as typing would), separated from
 * the neighbouring words by one space — none at the start of the field or a line, none before
 * whitespace or closing punctuation. The caret ends right after the phrase.
 */
export function insertDictated(value: string, selStart: number, selEnd: number, text: string): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  const phrase = text.trim();
  if (!phrase) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^[\s.,;:!?)\]}»]/.test(after) ? "" : " ";
  return { value: before + lead + phrase + trail + after, caret: before.length + lead.length + phrase.length };
}

// ── ordering finished phrases ──
// Completions of different phrases may arrive out of order; a phrase is released only after
// every phrase committed before it has completed or failed.

export type DictationSegments = {
  /** Committed item ids, oldest first, not yet released. */
  order: string[];
  /** Settled items: the transcript, or null when transcription failed. */
  settled: Record<string, string | null>;
};

export function emptySegments(): DictationSegments {
  return { order: [], settled: {} };
}

export function segmentCommitted(s: DictationSegments, itemId: string): DictationSegments {
  return s.order.includes(itemId) ? s : { ...s, order: [...s.order, itemId] };
}

export function segmentSettled(
  s: DictationSegments,
  itemId: string,
  transcript: string | null,
): { segments: DictationSegments; release: string[] } {
  const settled = { ...s.settled, [itemId]: transcript };
  // A completion for an item whose commit was never seen has nothing to wait for.
  const order = s.order.includes(itemId) ? s.order : [...s.order, itemId];
  const release: string[] = [];
  let i = 0;
  for (; i < order.length && order[i]! in settled; i++) {
    const text = settled[order[i]!];
    if (text) release.push(text);
    delete settled[order[i]!];
  }
  return { segments: { order: order.slice(i), settled }, release };
}

/** Every committed phrase has settled. */
export function segmentsDone(s: DictationSegments): boolean {
  return s.order.length === 0;
}
