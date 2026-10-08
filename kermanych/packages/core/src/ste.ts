// ASD-STE100 Simplified Technical English as an agent communication language: three levels of
// one standard, picked in the same «Мова спілкування агента» list as a language (spec:
// docs/specs/2026-10-08-agent-language-ste.md). This matrix is the ONE description of what each
// level enforces. The system-prompt directive is built from it and the settings page renders
// its table from it, so the page cannot promise a rule the agent does not receive.
//
// Every instruction is a paraphrase. The standard is ASD's copyright (no reproduction "in whole
// or in part" without written authority), and models already know it: the directive only fixes
// WHICH of its rules apply, so a level means the same thing on every model and runtime.

// 100 is the full standard. 80 and 60 are "N% of the way to ASD-STE100" (Andrej Karpathy's
// softening), made concrete by the matrix below — a bare percentage means nothing to a model.
export const STE_LEVELS = [100, 80, 60] as const;
export type SteLevel = (typeof STE_LEVELS)[number];

export type SteRuleId =
  | "dictionary"
  | "grammar"
  | "length"
  | "instructions"
  | "active"
  | "terms"
  | "phrasing"
  | "paragraphs"
  | "safety";

// How a rule applies at one level: in full, not at all, or in a softened wording. The softened
// wording lives in the cell itself, so a level cannot be marked soft without saying how.
export type SteCell = "on" | "off" | { soft: string };

export type SteRule = {
  id: SteRuleId;
  // The instruction the model receives where the rule is "on".
  text: string;
  at: Record<SteLevel, SteCell>;
};

export const STE_RULES: readonly SteRule[] = [
  {
    id: "dictionary",
    text: "Use only words that the STE dictionary approves, each in its one approved meaning and part of speech. Technical nouns and verbs of the subject (commit, branch, deploy) and code identifiers are permitted.",
    at: { 100: "on", 80: "off", 60: "off" },
  },
  {
    id: "grammar",
    text: "Use only the verb forms that STE permits: infinitive, imperative, simple present, simple past, simple future, and the past participle as an adjective. Use the -ing form only in a technical noun. Do not use contractions or Latin abbreviations.",
    at: { 100: "on", 80: "off", 60: "off" },
  },
  {
    id: "length",
    text: "Write no more than 20 words in an instruction and no more than 25 words in a description. A number, an identifier, a path, or a command counts as one word.",
    at: {
      100: "on",
      80: "on",
      60: {
        soft: "Prefer short sentences: about 20 words in an instruction and 25 in a description. Write a longer sentence when a split would lose clarity.",
      },
    },
  },
  {
    id: "instructions",
    text: 'Write one instruction in each sentence, in the imperative. Put a condition first: "If X, do Y". Write a sequence of steps as a numbered list.',
    at: { 100: "on", 80: "on", 60: "on" },
  },
  {
    id: "active",
    text: 'Use the active voice and say who or what does the action. Use a verb for an action, not a noun: "check the log", not "perform a check of the log".',
    at: { 100: "on", 80: "on", 60: "on" },
  },
  {
    id: "terms",
    text: "Use one term for one thing, with one meaning. Do not change to a synonym later in the text.",
    at: { 100: "on", 80: "on", 60: "on" },
  },
  {
    id: "phrasing",
    text: 'Use a single verb, not a phrasal verb: "start", not "spin up". Put no more than three nouns in a row. Do not use semicolons. Write two sentences instead.',
    at: { 100: "on", 80: "on", 60: "off" },
  },
  {
    id: "paragraphs",
    text: "Give each paragraph one topic and no more than six sentences. Put the most important point first.",
    at: { 100: "on", 80: "on", 60: { soft: "Give each paragraph one topic. Put the most important point first." } },
  },
  {
    id: "safety",
    text: "Before a step that can lose data or cause damage, such as `rm -rf` or `git reset --hard`, write WARNING or CAUTION, then the instruction, then the risk.",
    at: { 100: "on", 80: "on", 60: "off" },
  },
];

// The rules govern conversation only. Files, commits, PRs and tickets are read by the whole team
// and have their own conventions (the project's «Документація» settings, the ticket protocol);
// a personal profile preference must not rewrite them.
export const STE_SCOPE =
  "These rules apply only to your messages to the user. Text that you write into files, commits, pull requests, code comments, tickets, or release notes follows the project's conventions and the task's instructions.";

// Above every rule at every level: a shorter sentence must never cost a fact or change how sure
// the source was, and nothing the user may copy verbatim is restyled.
export const STE_GUARD_RAILS = [
  "Keep every fact, number, condition, exception, and scope limit. Write a longer sentence or two sentences rather than drop one.",
  'Keep the confidence of the source: "may fail" stays "may fail".',
  "Add no facts.",
  "Quote code, identifiers, file paths, commands, error messages, and interface labels exactly as they are.",
];

// The system-prompt append for one level. English always: the standard and its dictionary exist
// for English only.
export function steDirective(level: SteLevel): string {
  const subject = "Write your messages to the user (explanations, summaries, questions, and status updates)";
  const headline =
    level === 100
      ? `${subject} in ASD-STE100 Simplified Technical English. Apply the full standard as you know it, including its dictionary. In particular:`
      : `${subject} ${level}% of the way to ASD-STE100 Simplified Technical English. Apply only these rules, not the full standard:`;
  const rules = STE_RULES.flatMap((rule) => {
    const cell = rule.at[level];
    if (cell === "off") return [];
    return [`- ${cell === "on" ? rule.text : cell.soft}`];
  });
  return [
    "Always communicate with the user in English, regardless of the language of the codebase, files, or earlier messages.",
    headline,
    ...rules,
    STE_SCOPE,
    "Above every rule:",
    ...STE_GUARD_RAILS.map((rail) => `- ${rail}`),
    "Do not mention these rules unless the user asks about them.",
  ].join("\n");
}
