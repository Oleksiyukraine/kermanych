// The language the agent communicates back in. Mirrors AgentRuntimeKind's shape: a frozen
// tuple as the single source of truth, a derived union, and a boundary guard used wherever
// the value arrives as an unvalidated string (HTTP body, cloud row, env var). Unset (null /
// absent) means "no preference" — the agent keeps its own default and no directive is injected.
export const AGENT_LANGUAGES = ["uk", "en", "de", "es", "fr", "pl", "it", "pt", "ja", "zh"] as const;
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

export function isAgentLanguage(v: unknown): v is AgentLanguage {
  return typeof v === "string" && (AGENT_LANGUAGES as readonly string[]).includes(v);
}

// Endonyms (each language's own name) for UI option labels. Locale-independent, so the picker
// reads the same in every app locale and needs no per-locale translation table.
export const AGENT_LANGUAGE_LABELS: Record<AgentLanguage, string> = {
  uk: "Українська",
  en: "English",
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
// English, but names the target language explicitly).
const AGENT_LANGUAGE_ENGLISH_NAMES: Record<AgentLanguage, string> = {
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
// its endonym so the model cannot misread the tag.
export function agentLanguageDirective(lang: AgentLanguage): string {
  const name = AGENT_LANGUAGE_ENGLISH_NAMES[lang];
  const endonym = AGENT_LANGUAGE_LABELS[lang];
  return `Always communicate with the user in ${name} (${endonym}), regardless of the language of the codebase, files, or earlier messages. Write every explanation, summary, question, and status update in ${name}. Code, identifiers, file paths, and commands stay in their original form.`;
}
