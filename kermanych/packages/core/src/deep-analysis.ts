// «Глибокий аналіз» — the second way to start a task (docs/specs/2026-10-08-deep-analysis-task.md).
// The same agent as «Нова задача»; only its opening turn differs: the task arrives wrapped in
// this prompt, which holds the code back until the operator has been interviewed, the
// decisions are written down and the operator has approved them.

import { DOCS_LAYOUT } from "./doc-policy";

// The default skill that carries the method, resolved by name like the documentation skills,
// so a project, workspace or repository override wins (SkillsService.assignedForNames).
export const DEEP_ANALYSIS_SKILL = "deep-analysis";

// The opening prompt of a deep-analysis session. The caller appends the resolved skill block;
// the steps below are a complete ask on their own, because that block is empty whenever the
// skill cannot be resolved (offline cloud, unreadable repository).
export function deepAnalysisPrompt(task: string): string {
  return [
    "This task was filed as «Глибокий аналіз» (deep analysis): discuss and document it first, and do not change any code until the operator approves the written decisions.",
    "",
    "1. Study the code and documentation the task touches. Never ask the operator what the repository can answer.",
    "2. Interview the operator until every decision is settled: one question per message, each with the options you see and your recommended answer. Use your harness's tool for asking the user if it has one; otherwise ask in plain text and end the turn.",
    `3. Write the task document (\`${DOCS_LAYOUT.specs}/YYYY-MM-DD-<topic>.md\` unless this project's documentation policy names another place), commit it on this branch, summarise the decisions and ask for an explicit go-ahead.`,
    "4. Implement only after the operator approves, following the document.",
    "",
    `The \`${DEEP_ANALYSIS_SKILL}\` skill describes each step.`,
    "",
    "## Task",
    "",
    task,
  ].join("\n");
}
