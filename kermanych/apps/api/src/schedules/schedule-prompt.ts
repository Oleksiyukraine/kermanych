// apps/api/src/schedules/schedule-prompt.ts
// The opening prompt of a scheduled agent run (docs/specs/2026-11-06-scheduled-tasks.md,
// decision 2 and «Unattended»): the run's rules first — a scheduled task, nobody answers,
// analysis only, the first line of the final answer is a one-line summary, the notes section at
// its end — then the task's skills (SkillsService.assignedForNames, already rendered as a block),
// the task's memory (docs/specs/2026-11-23-scheduled-task-run-memory.md: what its earlier runs
// concluded and how the operator took it, the previous run's notes, the findings earlier runs
// reported), and the operator's own words last. English like every Kermanych instruction to an
// agent; the operator's prompt stays in whatever language they wrote it.
import {
  beforePromptChange,
  currentNotesRun,
  formatZonedWall,
  RUN_NOTES_HEADING,
  RUN_NOTES_MAX,
  SCHEDULE_RUNS_KEEP,
  type AgentFinding,
  type ScheduledTask,
  type ScheduleRun,
} from "@kermanych/core";
import { findingLine } from "../findings/findings-tools";

// The tools a run without a project gets (decision 9): read-only file tools, web search, and
// `read`, which also opens web pages. No bash, no edit, no write, no ask.
export const ONE_SHOT_TOOLS = ["read", "grep", "glob", "web_search"] as const;

// How many findings of earlier runs a project run is told (run memory, decision 3).
export const EARLIER_FINDINGS_MAX = 50;

// What of the task the memory blocks read.
export type RunMemoryTask = Pick<ScheduledTask, "timeZone" | "promptChangedAt" | "notesClearedAt">;

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
    `End your final answer with a section headed exactly «${RUN_NOTES_HEADING}»: what the next run of this task needs to carry on — what you checked and up to where, what to look at next. Kermanych cuts it out of your answer and hands it to the next run only. Rewrite it in full every time, keeping what still matters from the notes you were given; at most ${RUN_NOTES_MAX} characters.`,
  ].join("\n\n");
}

// A run's occurrence in the task's zone, as the blocks stamp it.
function stamp(run: ScheduleRun, timeZone: string): string {
  return formatZonedWall(new Date(run.scheduledFor ?? run.startedAt), timeZone).replace("T", " ");
}

// What the task's earlier runs concluded, newest first: each run that finished with a summary
// (the first line of its answer), stamped with its occurrence in the task's zone, marked with
// the operator's reaction and when it answered an older wording of the task. Every run starts in
// a fresh context, so without this a «propose one new feature» task proposes the same feature
// again. `runs` is the registry's list, newest first; the run in flight has no summary.
export function earlierResultsBlock(task: RunMemoryTask, runs: readonly ScheduleRun[]): string {
  const lines = runs
    .filter((r) => r.status === "done" && r.summary?.trim())
    .slice(0, SCHEDULE_RUNS_KEEP)
    .map((r) => {
      const reaction = r.reaction === "taken" ? " [taken into work]" : r.reaction === "rejected" ? " [rejected]" : "";
      const older = beforePromptChange(task, r) ? " (before the task was last changed)" : "";
      return `- ${stamp(r, task.timeZone)} — ${r.summary!.trim()}${reaction}${older}`;
    });
  if (!lines.length) return "";
  return [
    "\n\n## Earlier runs of this task",
    "What the earlier runs of this task concluded, newest first (the first line of each answer). Treat them as already delivered: do not offer the same result again under another name — find something new, build on one of them, or say what changed since. «[taken into work]»: the operator is working on it, so you may build on it. «[rejected]»: the operator turned it down, so do not offer it again or build on it. «(before the task was last changed)»: it answered an earlier wording of the task.",
    lines.join("\n"),
  ].join("\n\n");
}

// The notes the previous run left for this one (run memory, decision 1), unless the operator
// cleared them since (decision 6).
export function previousNotesBlock(task: RunMemoryTask, runs: readonly ScheduleRun[]): string {
  const run = currentNotesRun(task, runs);
  if (!run) return "";
  const older = beforePromptChange(task, run) ? " They were written before the task was last changed: keep only what still fits it." : "";
  return ["\n\n## Notes from the previous run", `What the run of ${stamp(run, task.timeZone)} left for this run.${older}`, run.notes!].join("\n\n");
}

// What the task's earlier runs already reported through `report_finding` (run memory, decision
// 3): `list_findings` sees only this run's session, so without this each run files them again.
export function earlierFindingsBlock(findings: readonly AgentFinding[]): string {
  if (!findings.length) return "";
  return [
    "\n\n## Findings earlier runs reported",
    "What the earlier runs of this task already reported through `report_finding`, newest first. Do not report them again; a dismissed one was turned down by the operator.",
    findings.map((f) => `- ${findingLine(f)}`).join("\n"),
  ].join("\n\n");
}

// The task's whole memory, each block starting with its own blank line or empty.
export function runMemoryBlock(task: RunMemoryTask, runs: readonly ScheduleRun[], findings: readonly AgentFinding[]): string {
  return `${earlierResultsBlock(task, runs)}${previousNotesBlock(task, runs)}${earlierFindingsBlock(findings)}`;
}

// The whole opening prompt: the rules, the skills block (it starts with its own blank line,
// or is empty), the memory (the same) and the task.
export function scheduledRunPrompt(input: { name: string; prompt: string; skillsBlock: string; memoryBlock: string; project: boolean }): string {
  return `${scheduledRunRules(input.name, input.project)}${input.skillsBlock}${input.memoryBlock}\n\n## The task\n\n${input.prompt.trim()}`;
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
