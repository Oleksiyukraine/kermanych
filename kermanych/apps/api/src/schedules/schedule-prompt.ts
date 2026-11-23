// apps/api/src/schedules/schedule-prompt.ts
// The opening prompt of a scheduled agent run (docs/specs/2026-11-06-scheduled-tasks.md,
// decision 2 and «Unattended»): the run's rules first — a scheduled task, nobody answers,
// analysis only, the first line of the final answer is a one-line summary — then the task's
// skills (SkillsService.assignedForNames, already rendered as a block), what the task's earlier
// runs concluded, and the operator's own words last. English like every Kermanych instruction to
// an agent; the operator's prompt stays in whatever language they wrote it.
import { formatZonedWall, type ScheduleRun } from "@kermanych/core";

// The tools a run without a project gets (decision 9): read-only file tools, web search, and
// `read`, which also opens web pages. No bash, no edit, no write, no ask.
export const ONE_SHOT_TOOLS = ["read", "grep", "glob", "web_search"] as const;

// How many earlier results a run is told: enough to stop it repeating the last weeks of a daily
// task, few enough to stay a short block.
export const EARLIER_RESULTS_MAX = 10;

// The rules every scheduled run starts with. `project`: a run in a project's worktree, whose
// session has the `kermanych` MCP server and so `report_finding`; a one-shot run has neither.
export function scheduledRunRules(name: string, project: boolean): string {
  return [
    `You are running the scheduled task «${name}». Kermanych started you on its schedule; nobody is watching this run and nobody will answer a question. Never ask: decide within the task and say what you assumed.`,
    project
      ? "This run is analysis only. You may read the code, run the tests and the live preview, and write a report file when a skill tells you to. Never commit, never push, never open a pull request, and leave every tracked file as you found it: the worktree is removed when the run ends."
      : "This run is analysis only: research and answer. You have read-only file tools, web search, and `read` for web pages; nothing you do changes anything.",
    project
      ? "Ideas and bugs you come across go through `report_finding`, one call each; do not fix them."
      : "Ideas and problems you come across go into your answer.",
    "The FIRST LINE of your final answer is a one-line summary of the result (it is shown alone in the operator's notifications); the rest of the answer follows below it.",
  ].join("\n\n");
}

// What the task's earlier runs concluded, newest first: each run that finished with a summary
// (the first line of its answer), stamped with its occurrence in the task's zone. Every run
// starts in a fresh context, so without this a «propose one new feature» task proposes the same
// feature again. `runs` is the registry's list, newest first; the run in flight has no summary.
export function earlierResultsBlock(runs: readonly ScheduleRun[], timeZone: string): string {
  const lines = runs
    .filter((r) => r.status === "done" && r.summary?.trim())
    .slice(0, EARLIER_RESULTS_MAX)
    .map((r) => `- ${formatZonedWall(new Date(r.scheduledFor ?? r.startedAt), timeZone).replace("T", " ")} — ${r.summary!.trim()}`);
  if (!lines.length) return "";
  return [
    "\n\n## Earlier runs of this task",
    "What the earlier runs of this task concluded, newest first (the first line of each answer). Treat them as already delivered: do not offer the same result again under another name — find something new, build on one of them, or say what changed since.",
    lines.join("\n"),
  ].join("\n\n");
}

// The whole opening prompt: the rules, the skills block (it starts with its own blank line,
// or is empty), the earlier results (the same) and the task.
export function scheduledRunPrompt(input: { name: string; prompt: string; skillsBlock: string; earlierBlock: string; project: boolean }): string {
  return `${scheduledRunRules(input.name, input.project)}${input.skillsBlock}${input.earlierBlock}\n\n## The task\n\n${input.prompt.trim()}`;
}

// The first non-empty line of an answer, for the run's `summary` and the slip's `text`.
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}
