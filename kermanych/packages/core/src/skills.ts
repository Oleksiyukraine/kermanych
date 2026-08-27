// Skill-library primitives shared by the API (materialiser) and the UI (editor).
// Pure data and serialisation: no fs, no cloud, no omp process knowledge.

export type SkillDef = { name: string; description: string; body: string };

// What the UI lists and what the transcript labels a row with. `shadowedByRepo` is the
// absolute path of the repository skill that won the name, so the override is never silent.
export type SkillView = {
  name: string;
  description: string;
  source: "default" | "project";
  shadowedByRepo?: string;
};

// A skill name is also a directory name under ~/.kermanych/skills/<projectId>/, so this
// pattern is a security boundary rather than cosmetics: no separators, no dots, no
// traversal. The `check` constraint on project_skills.name is the same expression.
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSkillName(v: string): boolean {
  return SKILL_NAME_RE.test(v);
}

// omp reads `<dir>/<name>/SKILL.md` and needs BOTH keys — a custom-directory skill without
// a description is dropped at discovery. The description is emitted as a JSON string, which
// is valid YAML and survives colons, quotes and newlines without hand-rolled escaping.
export function renderSkillFile(s: SkillDef): string {
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.replace(/\s+$/, "")}\n`;
}

// Kermanych's own library: both entries describe THIS harness's instrumentation, which no
// repository can know. Editing or adding a default is a content change to this constant.
// Every default is overridable and disableable per project.
export const DEFAULT_SKILLS: readonly SkillDef[] = [
  {
    name: "kermanych-session",
    description:
      "Use when you need to know how this session's git isolation works — the worktree, the branch, carried .env files, or who merges — before committing, switching branches or touching .env.",
    body: [
      "# Working inside a Kermanych session",
      "",
      "This session was launched by Kermanych, not by a human shell. The rules below are",
      "properties of the harness, so they hold no matter what the repository says.",
      "",
      "## Where you are",
      "",
      "- You run in a dedicated git worktree under `~/.kermanych/worktrees/<sessionId>`, on a",
      "  branch created for this task. The developer's own checkout is a different directory",
      "  and must never be touched.",
      "- **Never switch, rebase onto, or delete the session branch.** The operator's merge and",
      "  delete actions assume the worktree is still on it; resuming after a switch fails.",
      "",
      "## Carried files",
      "",
      "- `.env` (and any other file the project lists as a carry file) was **copied** into this",
      "  worktree so the app can run. It is not tracked. Never `git add` it, never paste its",
      "  values into code, a commit message, or a PR body.",
      "",
      "## Who finishes the work",
      "",
      "- Commit on this branch as you go. **The merge is the operator's action** («Завершити» in",
      "  the UI) — do not merge into the base branch yourself.",
      "- If a merge is already in progress with conflicts, the operator triggers conflict",
      "  resolution explicitly; resolve every marker and complete the merge commit only then.",
    ].join("\n"),
  },
  {
    name: "kermanych-pull-request",
    description:
      "Use before opening a pull request for a Kermanych session branch: what to commit first, which base branch to target, and how to push the session branch.",
    body: [
      "# Opening a pull request from a Kermanych session",
      "",
      "The repository's own `### PR Conventions` / `### Commit Conventions` (CLAUDE.md,",
      "AGENTS.md) always win. Use this when the repository defines none.",
      "",
      "## Order of operations",
      "",
      "1. Commit every uncommitted change on the session branch first — a PR opened from a",
      "   dirty worktree silently omits work.",
      "2. Push the session branch to `origin` and set its upstream.",
      "3. Open the PR against the session's base branch (the branch the worktree was created",
      "   from), not against whatever the remote's default happens to be.",
      "",
      "## Content",
      "",
      "- Commits and PR title: Conventional Commits — `type(scope): summary`, imperative mood.",
      "- PR body: a `## Summary` section (what changed and why) and a `## Testing` section",
      "  (commands actually run, and their result).",
      "- Keep the PR scoped to this branch's work; never fold in unrelated changes.",
      "",
      "## When the remote refuses",
      "",
      "A `404` from the forge on push or PR creation is an authorisation failure, not a missing",
      "repository: report the exact command and error to the operator instead of falling back",
      "to a compare URL and calling the task done.",
    ].join("\n"),
  },
];
