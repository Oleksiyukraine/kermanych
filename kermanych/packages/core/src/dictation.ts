import { isAgentLanguage, type AgentLanguage } from "./language";

// Voice dictation («Диктування»): the operator speaks and a local recogniser on this machine
// (docs/specs/2026-11-14-local-voice-dictation.md; the first, OpenAI-based version was
// docs/specs/2026-11-03-voice-dictation.md) turns each phrase into text. This file holds what the
// api and the ui must agree on (the language, the recogniser's vocabulary) and the pure decisions
// the ui performs: when a phrase ends, how its text joins the field, in which order finished
// phrases are released, which texts are the recogniser's inventions, and when a composer sends.

// Decision 12: context for Whisper, read as the text that came before. Technical names are spoken
// in English inside Ukrainian speech. Measured on the operator's recordings (2026-11-14): a plain
// word list brought «KPanel», «placeholder», «email» but broke Ukrainian words («відміни» → «від
// мені»); this one natural sentence kept both and gave the lowest error rate (23.7 % vs 25.9 %
// without a prompt).
export const DICTATION_PROMPT = "Онови компонент у KPanel: додай toast, зміни placeholder в інпуті та поле email у формі.";

// The agent language → Whisper's language code. An ASD-STE100 level is English.
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
  zh: "zh",
};

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(LANGUAGE_CODES));

// The operator speaks the agent's language, falling back to the ui locale, like the voice
// conversation.
export function dictationLanguage(agentLanguage: unknown, uiLocale: "uk" | "en"): string {
  return isAgentLanguage(agentLanguage) ? LANGUAGE_CODES[agentLanguage] : uiLocale;
}

/** The api's guard: only what `dictationLanguage` can produce reaches the recogniser. */
export function isDictationLanguage(v: unknown): v is string {
  return typeof v === "string" && KNOWN_CODES.has(v);
}

// ── the recogniser's inventions ──
// Decision 11: on silence, a cough or noise Whisper writes what its training subtitles ended
// with. A phrase whose whole text is one of these is dropped. Compared lower-cased, without
// punctuation; the prefixes cover the long credit lines.
const INVENTED: Record<string, true> = {
  "дякую": true,
  "дякую за перегляд": true,
  "дякую за увагу": true,
  "дякуємо за перегляд": true,
  "продовження далі": true,
  "продовження буде": true,
  // Music or a hum in the background, written without the brackets of a described sound.
  "музика": true,
  "music": true,
  "thank you": true,
  "thanks for watching": true,
  "thank you for watching": true,
  "you": true,
};
const INVENTED_PREFIXES = ["субтитри", "субтитрування", "subtitles by", "редактор субтитрів", "переклад субтитрів"];

// A sound Whisper describes instead of transcribing: «*coughs*», «[музика]», «(сміх)».
const ANNOTATION = /^\s*(\*[^*]*\*|\[[^\]]*\]|\([^)]*\))\s*$/u;

export function isInventedPhrase(text: string): boolean {
  if (ANNOTATION.test(text)) return true;
  const said = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!said) return true;
  return Object.hasOwn(INVENTED, said) || INVENTED_PREFIXES.some((p) => said.startsWith(p));
}

// ── client-side VAD ──
// The mic level is the capture's meter (0…1, normal speech fills most of it).
export const DICTATION_SPEECH_LEVEL = 0.1;
// A pause this long after speech ends the phrase: it is cut and transcribed (decision 6).
export const DICTATION_PAUSE_MS = 800;
// A popup's dictation stops after this long without speech.
export const DICTATION_IDLE_MS = 60_000;
// Decision 14: a composer's dictation stays on between messages, but not forever.
export const DICTATION_COMPOSER_IDLE_MS = 600_000;
// Decision 3: after this long without speech, the text dictated into a composer sends itself.
// Measured on the operator's recordings (2026-11-14): pauses inside one request reached 2.0 s
// (a list said with pauses, a long free request), so the send waits half a second longer.
export const DICTATION_SEND_MS = 2_500;

export type VadState = {
  /** When speech was last above the level (or when dictation started). */
  lastSpeechAt: number;
  /** Speech was heard since the last commit. */
  pending: boolean;
};

export function vadStart(now: number): VadState {
  return { lastSpeechAt: now, pending: false };
}

export type VadOptions = {
  /** Decision 10: the noise gate's threshold when it is above the speech level. */
  speechLevel?: number;
  /** Decision 14: the silence that stops dictation. */
  idleMs?: number;
};

export function vadStep(state: VadState, level: number, now: number, opts: VadOptions = {}): { state: VadState; commit: boolean; idle: boolean } {
  if (level >= Math.max(DICTATION_SPEECH_LEVEL, opts.speechLevel ?? 0)) return { state: { lastSpeechAt: now, pending: true }, commit: false, idle: false };
  const quiet = now - state.lastSpeechAt;
  if (state.pending && quiet >= DICTATION_PAUSE_MS) return { state: { ...state, pending: false }, commit: true, idle: false };
  return { state, commit: false, idle: quiet >= (opts.idleMs ?? DICTATION_IDLE_MS) };
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
