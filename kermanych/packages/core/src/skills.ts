// Skill-library primitives shared by the API (materialiser) and the UI (editor).
// Pure data and serialisation: no fs, no cloud, no omp process knowledge.

import type { TranscriptEntry } from "./types";

export type SkillDef = { name: string; description: string; body: string };

// What the UI lists and what the transcript labels a row with. `shadowedByRepo` is the
// absolute path of the repository skill that won the name, so the override is never silent.
export type SkillView = {
  name: string;
  description: string;
  source: "default" | "project";
  shadowedByRepo?: string;
};

/**
 * What `GET /projects/:id/skills` answers: the resolved library, and the names the bound
 * checkout's own skill directories define, keyed by name to the absolute path of the file
 * that owns them.
 *
 * The two lists are NOT interchangeable and neither subsumes the other. `view` is the
 * LIBRARY — Kermanych's defaults plus the project's rows, with `shadowedByRepo` set on the
 * names the repository also defines. `repo` is the REPOSITORY, and it holds names the
 * library has never heard of. A name in `repo` alone is still deliverable: the resolver
 * reads the repository's file for it (SkillsService.assignedForNames), so a consumer that
 * treats absence from `view` as "no such skill" would be wrong about it.
 */
export type ProjectSkillsPayload = {
  view: SkillView[];
  repo: Record<string, string>;
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
  // The name is a plain YAML scalar, so an unvalidated one could close the frontmatter and
  // inject keys (e.g. `alwaysApply`). Both callers must go through this guard.
  if (!isSkillName(s.name)) throw new Error(`invalid skill name: ${s.name}`);
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.replace(/\s+$/, "")}\n`;
}

// Kermanych's own library: both entries describe THIS harness's instrumentation, which no
// repository can know. Editing or adding a default is a content change to this constant.
// Every default is overridable and disableable per project.
export const DEFAULT_SKILLS: readonly SkillDef[] = [
  {
    name: "kermanych-session",
    description:
      "Use when you need to know how this session's git isolation works — the worktree, the branch, carried .env files, or how the code is delivered — before committing, switching branches or touching .env.",
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
      "- **Never switch, rebase onto, or delete the session branch.** The operator's finish and",
      "  delete actions assume the worktree is still on it; resuming after a switch fails.",
      "",
      "## Carried files",
      "",
      "- `.env` (and any other file the project lists as a carry file) was **copied** into this",
      "  worktree so the app can run. It is not tracked. Never `git add` it, never paste its",
      "  values into code, a commit message, or a PR body.",
      "",
      "## How the work is delivered",
      "",
      "- Commit on this branch as you go. Code leaves Kermanych **through a pull request only** —",
      "  there is no merge button. Never merge this branch into the base branch yourself.",
      "- «Завершити» in the UI is the operator retiring the session: the worktree is removed and",
      "  this branch is kept for its PR.",
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

// Which skills a session actually pulled in, in order of first use. Derived from the
// transcript, so it needs no extra state anywhere: a `skill` row's target is the skill name,
// with an optional sub-resource path after the first slash.
export function skillsUsed(entries: readonly TranscriptEntry[]): string[] {
  const seen: string[] = [];
  for (const e of entries) {
    if (e.kind !== "tool" || e.tool !== "skill" || !e.target) continue;
    const name = e.target.split("/")[0]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * The header of the block an agent's instruction carries for its assigned skills.
 *
 * The second sentence IS the de-duplication mechanism. The library may still advertise the
 * same skill — an already-running session's skill set is fixed when its process starts, so
 * there is no flag to filter it — and re-reading it would spend context on text the agent
 * already has in front of it.
 */
export const ASSIGNED_BLOCK_HEADER =
  "## Скіли, призначені цій ролі\nНаведені повністю — не читай їх повторно через `skill://`.";

// Appended to a rendered instruction, so it opens with its own blank line: the caller
// concatenates and never has to know the shape. An empty assignment adds NOTHING — a bare
// heading would tell the agent to look for skills that are not there.
export function assignedBlock(defs: readonly SkillDef[]): string {
  if (defs.length === 0) return "";
  const bodies = defs.map((d) => `### ${d.name}\n${d.body.trim()}`).join("\n\n");
  return `\n\n${ASSIGNED_BLOCK_HEADER}\n\n${bodies}`;
}
