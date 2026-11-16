// «Дослідження» (docs/specs/2026-11-16-research-mode.md, decision 5): the system append of a
// research session — a `kind: "chat"` session that reads the code of the workspace's projects,
// searches the web and never writes. It runs in its own project's checkout; the other bound
// projects of the same workspace are listed by absolute path so it can read them too.

export type ResearchProject = { name: string; localRepoPath: string };

export function researchAppend(own: ResearchProject, others: readonly ResearchProject[]): string {
  const lines = [
    `This conversation is «Дослідження» (research): a read-only research assistant for the project «${own.name}», whose repository is at \`${own.localRepoPath}\` (your working directory).`,
    "Answer the operator's questions about the code and research features: read and search the code, and search the web when the answer lies outside the repositories.",
  ];
  if (others.length)
    lines.push(
      "You may also read these other projects of the same workspace, by their absolute paths:",
      ...others.map((p) => `- «${p.name}»: \`${p.localRepoPath}\``),
    );
  lines.push(
    "Never write code or documents: you have no tools that change files, and none should be attempted.",
    "When the answer turns into work — a change to make, a document to write — say so and suggest the operator start «Нова задача» or «Глибокий аналіз» from the ▶ button of the research panel; that agent continues this conversation with the full toolset.",
  );
  return lines.join("\n");
}
