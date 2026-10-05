// apps/api/src/slack/slack-prompt.ts
// Everything the Slack documentation bot is told, as one pure function so the wording is
// testable without spawning a model. The rules are the management chat's documentation
// protocol (management-prompt.ts docsProtocol) re-stated for Slack: answer only from the
// fragments, never invent, explain in plain words for a non-technical reader — but cite as
// plain text, because Slack has no `kdoc:` links to open a file in Kermanych's preview, and
// format as Slack mrkdwn.
//
// English, unlike the management prompts: the channel's audience is whoever is in that
// Slack workspace, and the reply language follows the QUESTION, not the operator.
import type { ManagementDocFragment } from "@kermanych/core";
import type { TranscriptLine } from "./slack-map";

// The exact sentence the bot owes a question the documentation does not cover. Fixed, so a
// reader learns to recognise it as «not built», not as a model being vague.
export const NOT_BUILT_REPLY = "We do not have such feature built yet.";

// A prompt budget for the fragments. Eight matches per project across a few projects is
// already far more than one answer needs; past this the least relevant are dropped (the
// search returns them best-first) rather than letting a large workspace grow the prompt
// without bound.
const MAX_FRAGMENT_CHARS = 40_000;

export type SlackPromptDocs = { projectName: string; fragments: ManagementDocFragment[] };

export type SlackPromptInput = {
  workspaceName?: string;
  // Earlier messages of the thread, oldest first, WITHOUT the question itself.
  transcript: TranscriptLine[];
  question: string;
  docs: SlackPromptDocs[];
};

function fragmentLines(projectName: string, f: ManagementDocFragment): string {
  const head = `- ${projectName} › ${f.folder}/${f.path} › ${f.headingPath || "(no heading)"} (lines ${f.startLine}–${f.endLine})`;
  return [head, ...f.content.split("\n").map((l) => `    ${l}`)].join("\n");
}

function docsBlock(docs: SlackPromptDocs[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const d of docs)
    for (const f of d.fragments) {
      const block = fragmentLines(d.projectName, f);
      if (used + block.length > MAX_FRAGMENT_CHARS) break;
      used += block.length;
      blocks.push(block);
    }
  return blocks.length ? blocks.join("\n") : "- (no fragment matched the question)";
}

export function buildSlackAnswerPrompt(input: SlackPromptInput): string {
  const where = input.workspaceName ? ` for the Kermanych workspace «${input.workspaceName}»` : "";
  return [
    `You are Kermanych, answering a question in a Slack thread${where}. Your only source of truth is the project documentation fragments below.`,
    "",
    "RULES:",
    "1. Answer ONLY from the documentation fragments. The thread is conversational context (what was already asked and answered), never a source of facts about the product.",
    "2. Never invent features, settings, paths or behaviour, and never fill gaps from general knowledge.",
    `3. If the fragments do not describe what is asked, reply with exactly «${NOT_BUILT_REPLY}» — translated into the question's language if it is not English — and nothing else.`,
    "4. Reply in the language the question is written in.",
    "5. Format as Slack mrkdwn: no # headings, *bold* with single asterisks, `code` in backticks, links as <url|text>. Short paragraphs or bullet lists.",
    "6. Write for a non-technical reader, in simple and clear everyday words. Explain what the feature does for the person and how they use it — the screens, buttons and steps they see — not how it is built. Leave out code, file names, functions, endpoints, database tables, config keys and other internal names. Give technical detail only when the question explicitly asks for it, and then still say in plain words what it means. If a technical term cannot be avoided, explain it in a few words.",
    "7. Be concise: answer the question, do not restate the documentation.",
    "8. Unless you used rule 3, end with one line `_Sources:_` listing what you used as `project › path › heading`, separated by `; `.",
    "9. You have no tools and nobody can answer a follow-up question from you; if the question is ambiguous, answer the most likely reading and say which one you chose.",
    "",
    "── DOCUMENTATION FRAGMENTS ──",
    docsBlock(input.docs),
    "",
    "── THREAD SO FAR ──",
    input.transcript.length ? input.transcript.map((l) => `${l.who}: ${l.text}`).join("\n") : "(none — this is the first message)",
    "",
    "── QUESTION ──",
    input.question,
  ].join("\n");
}
