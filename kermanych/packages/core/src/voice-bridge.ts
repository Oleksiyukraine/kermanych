import type { RpcExtensionUIRequest, RpcExtensionUIResponse, TranscriptEntry } from "./types";

// The bridge between GPT-Live and the session's agent (docs/specs/2026-11-02-voice-conversation.md,
// decisions 5–8 and 10). Pure: the ui's voice store feeds it GPT-Live's events and the session's
// transcript, and performs what it decides. Nothing here knows WebRTC, the store or the api.

// ── What the agent receives ───────────────────────────────────────────────────

const NOTE_OPEN = "[Kermanych voice conversation]";
const NOTE_CLOSE = "[/Kermanych voice conversation]";

// Prepended to every message said in a voice conversation (decision 6). The transcript row keeps
// the operator's raw words; `unwrapVoiceMessage` restores them when history is re-read.
export const VOICE_NOTE = [
  NOTE_OPEN,
  "The operator's message below is a speech transcript: recognition errors are possible. If something reads as nonsense, ask instead of guessing.",
  "Your reply will be retold aloud by a voice model. Keep it short. No tables and no long code blocks; give options as a short numbered list. Paths and code may stay: they remain in the chat.",
  NOTE_CLOSE,
].join("\n");

export function voiceMessagePrompt(text: string): string {
  return `${VOICE_NOTE}\n\n${text}`;
}

/** The operator's own words when `text` is a voice message as the child received it, else null. */
export function unwrapVoiceMessage(text: string): string | null {
  const head = `${VOICE_NOTE}\n\n`;
  return text.startsWith(head) ? text.slice(head.length) : null;
}

// ── What the operator said ────────────────────────────────────────────────────

/** One `session.input_transcript.delta`, on the Live session's timeline. */
export type HeardFragment = { text: string; startMs: number };

/**
 * The words of one delegation: every fragment that started at or before the delegation's
 * `offset_ms`, in delivery order, and the fragments left for the next one. Fragments of the
 * phrase can still arrive after the delegation event, which is why the caller waits a moment
 * before taking it.
 */
export function takeUtterance(heard: readonly HeardFragment[], offsetMs: number): { text: string; rest: HeardFragment[] } {
  const taken = heard.filter((f) => f.startMs <= offsetMs);
  const rest = heard.filter((f) => f.startMs > offsetMs);
  return { text: taken.map((f) => f.text).join("").replace(/\s+/g, " ").trim(), rest };
}

// ── What a delegation becomes ─────────────────────────────────────────────────

export type VoiceAction =
  /** A message to the agent, in the operator's words. */
  | { kind: "send"; text: string }
  /** The answer to the agent's pending question (the decision block). */
  | { kind: "answer"; response: RpcExtensionUIResponse }
  /** Nothing to deliver: GPT-Live is told what to ask the operator. */
  | { kind: "askAgain"; commentary: string };

const ASKS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

export function delegationAction(utterance: string, pending: RpcExtensionUIRequest | undefined): VoiceAction {
  if (!utterance.trim()) return { kind: "askAgain", commentary: "Nothing was heard for this request. Ask the operator to repeat it." };
  if (!pending || !ASKS[pending.method]) return { kind: "send", text: utterance.trim() };
  const answer = parseUiAnswer(pending, utterance);
  if (answer) return { kind: "answer", response: answer };
  return {
    kind: "askAgain",
    commentary:
      pending.method === "confirm"
        ? "The agent's question needs a yes or a no, and the answer was neither. Ask the operator: yes or no?"
        : `The agent's question has options 1 to ${pending.options?.length ?? 0}, and the answer did not name one. Ask the operator for the option number.`,
  };
}

// Words are compared lower-cased, apostrophes unified and punctuation dropped.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ʼ’`']/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A refusal is matched first and taken out of the phrase, so «не роби» is a no rather than a no
// and a «роби». Lookahead, not a consumed space: two refusals in a row both match.
const NO = /(^| )(ні|нє|не треба|не потрібно|не варто|не роби|не згоден|не згодна|скасуй|відміна|no|nope|don't|do not|cancel)(?= |$)/g;
const YES = /(^| )(так|звісно|звичайно|авжеж|згоден|згодна|погоджуюсь|підтверджую|давай|роби|ок|окей|добре|yes|yeah|yep|sure|ok|okay|confirm)(?= |$)/;

// Option numbers as said, Ukrainian then English. Ordinals win over cardinals: in «the second
// one» or «другий, той один» the cardinal is a pronoun, not a second number.
const ORDINALS: readonly [number, RegExp][] = [
  [1, /^(перш\p{L}*|first)$/u],
  [2, /^(друг\p{L}*|second)$/u],
  [3, /^(трет\p{L}*|third)$/u],
  [4, /^(четверт\p{L}*|fourth)$/u],
  [5, /^(п'ят[иао]\p{L}*|пят[иао]\p{L}*|fifth)$/u],
  [6, /^(шост\p{L}*|sixth)$/u],
  [7, /^(сьом\p{L}*|seventh)$/u],
  [8, /^(восьм\p{L}*|eighth)$/u],
  [9, /^(дев'ят[иао]\p{L}*|ninth)$/u],
  [10, /^(десят[иао]\p{L}*|tenth)$/u],
];
const CARDINALS: readonly [number, RegExp][] = [
  [1, /^(один|одна|одне|one)$/u],
  [2, /^(два|дві|two)$/u],
  [3, /^(три|three)$/u],
  [4, /^(чотири|four)$/u],
  [5, /^(п'ять|пять|five)$/u],
  [6, /^(шість|six)$/u],
  [7, /^(сім|seven)$/u],
  [8, /^(вісім|eight)$/u],
  [9, /^(дев'ять|nine)$/u],
  [10, /^(десять|ten)$/u],
];

/**
 * The response a spoken answer makes to the agent's question, or null when it names nothing the
 * question accepts (decision 7). Never guesses between two options.
 */
export function parseUiAnswer(req: RpcExtensionUIRequest, utterance: string): RpcExtensionUIResponse | null {
  const said = normalize(utterance);
  if (!said) return null;
  const respond = (rest: { value: string } | { confirmed: boolean }): RpcExtensionUIResponse => ({ type: "extension_ui_response", id: req.id, ...rest });
  if (req.method === "input" || req.method === "editor") return respond({ value: utterance.trim() });
  if (req.method === "confirm") {
    const rest = said.replace(NO, " ");
    const no = rest !== said;
    const yes = YES.test(rest);
    return no === yes ? null : respond({ confirmed: yes });
  }
  if (req.method !== "select") return null;
  const options = req.options ?? [];
  const ordinals = new Set<number>();
  const cardinals = new Set<number>();
  for (const word of said.split(" ")) {
    const ordinal = ORDINALS.find(([, re]) => re.test(word))?.[0];
    const cardinal = /^\d{1,2}$/.test(word) ? Number(word) : CARDINALS.find(([, re]) => re.test(word))?.[0];
    if (ordinal !== undefined) ordinals.add(ordinal);
    if (cardinal !== undefined) cardinals.add(cardinal);
    if (word === "останній" || word === "остання" || word === "last") ordinals.add(options.length);
  }
  const inRange = [...(ordinals.size ? ordinals : cardinals)].filter((n) => n >= 1 && n <= options.length);
  if (inRange.length === 1) return respond({ value: options[inRange[0]! - 1]! });
  if (inRange.length > 1) return null;
  const matches = options.filter((o) => {
    const opt = normalize(o);
    return opt.length > 0 && (said.includes(opt) || (said.length >= 4 && opt.includes(said)));
  });
  return matches.length === 1 ? respond({ value: matches[0]! }) : null;
}

/** The decision block as GPT-Live should say it. */
export function describeUiRequest(req: RpcExtensionUIRequest): string {
  const parts = ["The agent asks the operator a question and waits for the answer."];
  if (req.title) parts.push(`Question: ${req.title}`);
  if (req.message) parts.push(req.message);
  if (req.method === "select" && req.options?.length) {
    parts.push(`Options: ${req.options.map((o, i) => `${i + 1}) ${o}`).join("; ")}.`);
    parts.push("Read the options with their numbers, then wait for the operator's choice.");
  } else if (req.method === "confirm") parts.push("It is a yes or no question.");
  else parts.push("It waits for a free answer in the operator's words.");
  return parts.join("\n");
}

// ── What the operator hears ───────────────────────────────────────────────────

// One append is limited to 500 tokens; Cyrillic runs near two characters a token, so this keeps
// a chunk under the limit with margin.
export const COMMENTARY_CHUNK_CHARS = 900;

/**
 * An agent reply cut into speakable chunks: fenced code and tables become a pointer to the chat,
 * then paragraphs are packed into chunks of at most `max` characters, a long paragraph split on
 * sentence boundaries and a long sentence cut hard.
 */
export function toCommentaryChunks(text: string, max = COMMENTARY_CHUNK_CHARS): string[] {
  const speakable = text
    .replace(/```[\s\S]*?(```|$)/g, "[code block — shown in the chat]")
    .replace(/(^|\n)(\|[^\n]*\|[ \t]*(\n|$))+/g, "$1[table — shown in the chat]\n");
  const pieces: string[] = [];
  for (const para of speakable.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= max) pieces.push(para);
    else
      for (const sentence of para.split(/(?<=[.!?…])\s+/))
        for (let i = 0; i < sentence.length; i += max) pieces.push(sentence.slice(i, i + max));
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last]!.length + 2 + piece.length <= max) chunks[last] = `${chunks[last]}\n\n${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

/** A short fact about the agent's progress for `session.thinking.append`, or null for nothing to say. */
export function progressNote(entry: TranscriptEntry): string | null {
  if (entry.kind === "tool") return `Agent progress: ${entry.intent ?? entry.tool}${entry.target ? ` — ${entry.target}` : ""}.`;
  if (entry.kind === "assistant_text") return `Agent progress, an intermediate message: ${entry.text.slice(0, 400)}`;
  return null;
}

// Progress is told at most this often, so a burst of tool calls does not flood GPT-Live's context.
export const PROGRESS_EVERY_MS = 15_000;

// ── When it ends ──────────────────────────────────────────────────────────────

// Decision 8: no operator speech, no GPT-Live speech and no running agent turn for this long.
export const VOICE_SILENCE_HANGUP_MS = 180_000;

export function shouldHangUp(lastActivityAt: number, agentBusy: boolean, now: number): boolean {
  return !agentBusy && now - lastActivityAt >= VOICE_SILENCE_HANGUP_MS;
}

/** The reply to speak when a turn ends: the last assistant message after the last operator message. */
export function finalReply(transcript: readonly TranscriptEntry[]): Extract<TranscriptEntry, { kind: "assistant_text" }> | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]!;
    if (e.kind === "assistant_text") return e;
    if (e.kind === "user_text") return undefined;
  }
  return undefined;
}
