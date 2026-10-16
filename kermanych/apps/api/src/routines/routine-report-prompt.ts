// apps/api/src/routines/routine-report-prompt.ts
// The prompt of a WORKSPACE prompt routine (docs/specs/2026-10-16-routines.md): the author's
// saved instructions, run unattended by a read-only one-shot child over every repository of the
// workspace, whose one answer is the run's report. A pure function so the wording is testable
// without spawning a child.
//
// Two things the child must know that an interactive chat does not need to say: nobody is there
// to answer a question, and the answer is a finished document that is stored (and maybe posted
// to Slack) exactly as written.
import type { ManagementRepo } from "@kermanych/core";

export type RoutineReportInput = {
  workspaceName: string;
  routineName: string;
  // The run's day and zone, so «yesterday» and «this week» in the instructions resolve.
  date: string;
  timezone: string;
  repos: ManagementRepo[];
  instructions: string;
  // The channel the report will be posted to, when the routine posts one.
  slackChannel?: string;
};

function repoLine(r: ManagementRepo): string {
  const where = r.localRepoPath || "not checked out on this machine — do not try to read it";
  const branch = r.defaultBranch ? ` · default branch ${r.defaultBranch}` : "";
  return `- ${r.name} · ${where}${branch}`;
}

export function buildRoutineReportPrompt(i: RoutineReportInput): string {
  const destination = i.slackChannel
    ? `It is stored in the routine's history and posted to the Slack channel #${i.slackChannel} as written.`
    : "It is stored in the routine's history as written.";
  return [
    `You are running the scheduled routine «${i.routineName}» of the workspace «${i.workspaceName}» in Kermanych.`,
    `Today is ${i.date} (${i.timezone}).`,
    "",
    "Nobody is watching this run and nobody can answer a question. Do not ask for clarification: when",
    "something the instructions need is missing or unclear, make the safest reasonable reading, and say",
    "in the report what you could not find or decide.",
    "",
    "You can only read: list, search and open files. You cannot edit files, run commands or change",
    "anything. The repositories of the workspace (absolute paths — open them by these paths):",
    ...(i.repos.length ? i.repos.map(repoLine) : ["- none is checked out on this machine"]),
    "",
    "Your final answer is the report itself, in Markdown, starting with a `# ` heading. " + destination,
    "Do not describe your process or the tools you used; give the result. Write in the language the",
    "instructions below are written in.",
    "",
    "Instructions:",
    i.instructions,
  ].join("\n");
}
