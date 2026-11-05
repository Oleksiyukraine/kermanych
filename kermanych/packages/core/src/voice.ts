import { agentLanguageEnglishName, isAgentLanguage } from "./language";

// Voice conversation («Голосова розмова», docs/specs/2026-11-02-voice-conversation.md): OpenAI
// GPT-Live speaks and listens, and every request about the task is delegated to the session's
// own agent. This file holds what the api and the ui must agree on: the model, the voice
// vocabulary, the conversation language and GPT-Live's prompt.

export const VOICE_MODEL = "gpt-live-1";

// GPT-Live's built-in voices (POST /v1/live/sessions, `session.audio.output.voice`). The api
// refuses anything else, so a typo never reaches OpenAI as an opaque 400.
export const VOICE_IDS = [
  "alloy", "ash", "ballad", "beacon", "bossa", "brise", "cedar", "cinder", "coral", "delta", "echo",
  "flitz", "gleam", "harema", "juni", "marin", "meridian", "nira", "noeul", "nuri", "quartz", "ripple",
  "sage", "shida", "shimmer", "sillage", "stone", "tempo", "verse", "vesper", "willow",
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

// OpenAI's own default voice.
export const DEFAULT_VOICE: VoiceId = "marin";

export function isVoiceId(v: unknown): v is VoiceId {
  return typeof v === "string" && (VOICE_IDS as readonly string[]).includes(v);
}

// The language GPT-Live speaks: the agent's communication language, so a retold reply is never
// translated on the way; with none set, the ui locale. Returns its English name.
export function voiceLanguage(agentLanguage: unknown, uiLocale: "uk" | "en"): string {
  if (isAgentLanguage(agentLanguage)) return agentLanguageEnglishName(agentLanguage);
  return uiLocale === "en" ? "English" : "Ukrainian";
}

// GPT-Live's conversation prompt (`session.instructions`). GPT-Live is the agent's voice: it
// delegates everything about the task and asks back only when it did not hear (decision 5).
export function voiceLivePrompt(language: string): string {
  return [
    `You are the voice of a coding agent in Kermanych. The operator talks to you to discuss a software task; the agent behind you has the repository, the tools and the whole history of the task. Speak ${language} unless the operator switches language.`,
    "",
    "Delegation:",
    "- Delegate every request about the task, the code, the repository, a plan or a decision. Never answer those yourself and never guess: you do not see the code.",
    "- Handle only these yourself: repeating or shortening what the agent said, telling what the agent is doing now from the progress you were given, greetings, and the operator asking you to stop talking.",
    "- If you did not hear the operator or the phrase broke off, ask them to repeat before delegating. Never ask about the substance: the agent does that.",
    "",
    "Retelling the agent:",
    "- When the agent's reply arrives, retell it close to its text. Add nothing, drop no decision, option or question.",
    "- Say file paths and identifiers once; do not spell code. If the reply mentions a code block or a table, say that it is in the chat.",
    "- When the agent asks a question with numbered options, read the options with their numbers and wait for the operator's answer.",
    "",
    "Style: short, natural sentences. No filler, no closing offers.",
  ].join("\n");
}
