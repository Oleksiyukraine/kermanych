// packages/core/src/routine-report-prompt.ts
// The prompt of a WORKSPACE prompt routine (docs/specs/2026-10-16-routines.md): the author's
// saved instructions, run unattended by a read-only model over every repository of the
// workspace, whose one answer is the run's report. A pure function so the wording is testable
// without spawning a child.
//
// Two runners read it: the local api (repositories are folders on this machine, omp's read-only
// tools) and the cloud runner (repositories on GitHub, its list_files/read_file/search_code
// tools). NO IMPORTS, on purpose — the slack-answer.ts rule: the routines-runner Edge Function
// imports this file by relative path from Deno.
//
// Two things the model must know that an interactive chat does not need to say: nobody is there
// to answer a question, and the answer is a finished document that is stored (and maybe posted
// to Slack) exactly as written.

// One repository as the prompt lists it. `location` is where to open it — an absolute path, or
// `GitHub owner/repo` — or empty when the runner cannot reach it.
export type RoutineReportRepo = { name: string; location: string; defaultBranch?: string };

export type RoutineReportInput = {
  workspaceName: string;
  routineName: string;
  // The run's day and zone, so «yesterday» and «this week» in the instructions resolve.
  date: string;
  timezone: string;
  repos: RoutineReportRepo[];
  // How the repositories are opened: the local api names folders, the cloud runner its tools.
  howToRead: string;
  instructions: string;
  // The channel the report will be posted to, when the routine posts one.
  slackChannel?: string;
};

export function buildRoutineReportPrompt(i: RoutineReportInput): string {
  const destination = i.slackChannel
    ? `It is stored in the routine's history and posted to the Slack channel #${i.slackChannel} as written.`
    : "It is stored in the routine's history as written.";
  const repoLines = i.repos.map((r) => {
    const where = r.location || "not reachable from this run — do not try to read it";
    return `- ${r.name} · ${where}${r.defaultBranch ? ` · default branch ${r.defaultBranch}` : ""}`;
  });
  return [
    `You are running the scheduled routine «${i.routineName}» of the workspace «${i.workspaceName}» in Kermanych.`,
    `Today is ${i.date} (${i.timezone}).`,
    "",
    "Nobody is watching this run and nobody can answer a question. Do not ask for clarification: when",
    "something the instructions need is missing or unclear, make the safest reasonable reading, and say",
    "in the report what you could not find or decide.",
    "",
    `You can only read: list, search and open files. You cannot edit files, run commands or change anything. ${i.howToRead}`,
    "The repositories of the workspace:",
    ...(repoLines.length ? repoLines : ["- none is reachable from this run"]),
    "",
    "Your final answer is the report itself, in Markdown, starting with a `# ` heading. " + destination,
    "Do not describe your process or the tools you used; give the result. Write in the language the",
    "instructions below are written in.",
    "",
    "Instructions:",
    i.instructions,
  ].join("\n");
}
