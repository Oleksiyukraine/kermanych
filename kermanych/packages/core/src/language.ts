import { steDirective, type SteLevel } from "./ste";

// The language the agent communicates back in. Mirrors AgentRuntimeKind's shape: a frozen
// tuple as the single source of truth, a derived union, and a boundary guard used wherever
// the value arrives as an unvalidated string (HTTP body, cloud row, env var). Unset (null /
// absent) means "no preference" — the agent keeps its own default and no directive is injected.
// The three `en-ste*` entries are levels of ASD-STE100 Simplified Technical English (ste.ts):
// English plus a fixed set of writing rules, listed right after plain English.
export const AGENT_LANGUAGES = ["uk", "en", "en-ste", "en-ste-80", "en-ste-60", "de", "es", "fr", "pl", "it", "pt", "ja", "zh"] as const;
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

// The codes that pick an ASD-STE100 level instead of a plain language.
const STE_LANGUAGE_LEVELS = {
  "en-ste": 100,
  "en-ste-80": 80,
  "en-ste-60": 60,
} as const satisfies Partial<Record<AgentLanguage, SteLevel>>;
type SteLanguage = keyof typeof STE_LANGUAGE_LEVELS;

function isSteLanguage(lang: AgentLanguage): lang is SteLanguage {
  return lang in STE_LANGUAGE_LEVELS;
}

export function isAgentLanguage(v: unknown): v is AgentLanguage {
  return typeof v === "string" && (AGENT_LANGUAGES as readonly string[]).includes(v);
}

// Endonyms (each language's own name) for UI option labels. Locale-independent, so the picker
// reads the same in every app locale and needs no per-locale translation table. The STE labels
// name the real standard plus a level: "ASD-STE80" would name a standard that does not exist.
export const AGENT_LANGUAGE_LABELS: Record<AgentLanguage, string> = {
  uk: "Українська",
  en: "English",
  "en-ste": "English — ASD-STE100",
  "en-ste-80": "English — ASD-STE100 (80%)",
  "en-ste-60": "English — ASD-STE100 (60%)",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  pl: "Polski",
  it: "Italiano",
  pt: "Português",
  ja: "日本語",
  zh: "中文",
};

// English names used to phrase the directive to the model (the instruction is written in
// English, but names the target language explicitly). The STE codes have their own directive.
const AGENT_LANGUAGE_ENGLISH_NAMES: Record<Exclude<AgentLanguage, SteLanguage>, string> = {
  uk: "Ukrainian",
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  pl: "Polish",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  zh: "Chinese",
};

// The system-prompt append that makes the agent talk back in the chosen language. Backend-
// neutral text: omp receives it via `--append-system-prompt`, the claude SDK via
// `systemPrompt.append`. Names the language in English (an instruction to the model) and in
// its endonym so the model cannot misread the tag. An ASD-STE100 level gets the level's own
// directive: English plus its writing rules (ste.ts).
export function agentLanguageDirective(lang: AgentLanguage): string {
  if (isSteLanguage(lang)) return steDirective(STE_LANGUAGE_LEVELS[lang]);
  const name = AGENT_LANGUAGE_ENGLISH_NAMES[lang];
  const endonym = AGENT_LANGUAGE_LABELS[lang];
  return `Always communicate with the user in ${name} (${endonym}), regardless of the language of the codebase, files, or earlier messages. Write every explanation, summary, question, and status update in ${name}. Code, identifiers, file paths, and commands stay in their original form.`;
}
