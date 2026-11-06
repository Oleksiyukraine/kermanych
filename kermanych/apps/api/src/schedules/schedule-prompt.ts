// apps/api/src/schedules/schedule-prompt.ts
// The opening prompt of a scheduled agent run (docs/specs/2026-11-06-scheduled-tasks.md,
// decision 2 and «Unattended»): the run's rules first — a scheduled task, nobody answers,
// analysis only, the first line of the final answer is a one-line summary — then the task's
// skills (SkillsService.assignedForNames, already rendered as a block) and the operator's own
// words last. English like every Kermanych instruction to an agent; the operator's prompt stays
// in whatever language they wrote it.

// The tools a run without a project gets (decision 9): read-only file tools, web search, and
// `read`, which also opens web pages. No bash, no edit, no write, no ask.
export const ONE_SHOT_TOOLS = ["read", "grep", "glob", "web_search"] as const;

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

// The whole opening prompt: the rules, the skills block (it starts with its own blank line,
// or is empty) and the task.
export function scheduledRunPrompt(input: { name: string; prompt: string; skillsBlock: string; project: boolean }): string {
  return `${scheduledRunRules(input.name, input.project)}${input.skillsBlock}\n\n## The task\n\n${input.prompt.trim()}`;
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
