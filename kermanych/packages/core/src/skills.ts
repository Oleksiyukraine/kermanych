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
      "`gh` errors like `must be a collaborator`, `403`, or `404` on push or PR creation are almost",
      "always the WRONG identity, not a real permissions wall: `gh` fell back to an ambient account",
      "because the project's `GIT_TOKEN` was not applied to that command. Apply the token inline on the",
      "same command (`GH_TOKEN=\"$TOKEN\" gh …`) and confirm the acting login with `gh api user --jq .login`",
      "before concluding anything. Report the exact command and error to the operator only once the token",
      "is confirmed applied and it still fails — never fall back to a compare URL and call the task done.",
    ].join("\n"),
  },
  {
    name: "qa-tester",
    description:
      "Use when composing a QA checklist for a task's change — the user-observable things a human tester should verify before it ships. Enriches what «Створити ПР» asks for; the output contract lives in the harness.",
    body: [
      "# Composing a QA checklist",
      "",
      "The reader is a HUMAN tester or a manager, not a model, and they read it after the work",
      "is done — often once the session is archived. Write for them.",
      "",
      "## What each item is",
      "",
      "- A single, user-observable outcome to verify by hand — a thing to DO and the result to",
      "  SEE, not an internal detail or a code reference.",
      "- Independently checkable: one tick, one verdict, no item that depends on another's result.",
      "- Plain language, in the language of the task, short enough to scan.",
      "",
      "## What to cover",
      "",
      "- The task's own acceptance criteria first: the change did what was asked.",
      "- The obvious ways in: the primary flow, and the empty / error / permission-denied paths",
      "  a real user hits.",
      "- Anything the change touched at the edges — a shared screen, a migration, a role or scope.",
      "",
      "## What to leave out",
      "",
      "- Anything an automated test already guarantees: this list is for what a person must eye.",
      "- Setup, build and deployment steps — those are not QA of the change itself.",
    ].join("\n"),
  },
  {
    name: "librarian",
    description:
      "Use during development to keep the project's documentation current: update the docs that describe behaviour the change adds or alters, in the same change.",
    body: [
      "# Keeping the project's documentation current",
      "",
      "You are the documentation conscience for this change.",
      "",
      "- When the change adds or alters behaviour a human needs to know — a new command,",
      "  endpoint, config key, migration, or user-facing flow — update the docs that describe it",
      "  in the SAME change, inside the repository's own documentation, following its existing",
      "  structure and tone.",
      "- Prefer updating an existing doc over adding a new one; add a file only when there is no",
      "  home for it. Never invent documentation the change does not warrant, and never paste",
      "  secrets or tokens into docs.",
    ].join("\n"),
  },
  {
    name: "task-spec",
    description:
      "Use when starting a task that changes the repository, to write its task document in docs/specs/ — and whenever the decisions or scope change, to keep it current.",
    body: [
      "# Writing the task document",
      "",
      "Path: `docs/specs/YYYY-MM-DD-<topic>.md`, created before implementing and kept current.",
      "Size it to the task: a fix gets a page, a feature a full spec.",
      "",
      "## Sections",
      "",
      "- **Goal** — what is asked and why; link the task or ticket.",
      "- **Context** — the current behaviour and the code it lives in.",
      "- **Decisions** — what was chosen, and the alternatives rejected with the reason.",
      "- **Changes** — what changes, by area: files, APIs, data, UI.",
      "- **Verification** — how it was proven: commands run and their result.",
      "- `## Documentation impact` — which living docs (`docs/schemas/` or the project's own)",
      "  this change updated. When behaviour did not change, begin the section with `None`",
      "  and the reason, e.g. `None — internal refactor, no behaviour change.`",
    ].join("\n"),
  },
  {
    name: "task-plan",
    description:
      "Use when a task needs an implementation plan in docs/plans/: the ordered steps, the files each touches, and how each is verified, written before implementing.",
    body: [
      "# Writing the implementation plan",
      "",
      "Path: `docs/plans/YYYY-MM-DD-<topic>.md`, written before implementing; link the task",
      "document in `docs/specs/` when there is one. The reader is whoever picks the work up",
      "next, human or agent.",
      "",
      "- **Steps** — ordered, each small enough to finish and check on its own.",
      "- **Files** — for every step, the files it creates or changes.",
      "- **Verification** — for every step, the command or check that proves it.",
      "- **Risks and order** — migrations, flags, what must ship first.",
      "",
      "Tick steps off as they land; when the plan changes, change the document.",
    ].join("\n"),
  },
  {
    name: "frontend-handoff",
    description:
      "Use when asked for a frontend handoff after a task: a document in docs/handoffs/ that tells a frontend developer who did not see the work what changed for the client.",
    body: [
      "# Writing a frontend handoff",
      "",
      "Path: `docs/handoffs/YYYY-MM-DD-<topic>.md`. The reader is a frontend developer who did",
      "not see this work; write so they can integrate without reading the diff.",
      "",
      "- **What changed for the client** — in a few lines.",
      "- **Endpoints** — method, path, request and response shape, errors.",
      "- **Realtime / events** — channels, event names, payloads.",
      "- **Breaking changes** — what old clients break on.",
      "- **Env / config** — new keys and flags.",
      "- **Migration order** — what must ship first.",
      "- **How to try it** — steps or requests that show it working.",
      "- **API requests answered** — when this work implements a request from",
      "  `docs/api-requests/`, link it and say which parts of it are covered.",
      "",
      "Skip empty sections. When nothing changed for the frontend, say so in one line.",
    ].join("\n"),
  },
  {
    name: "api-request",
    description:
      "Use when the work needs something the API does not provide yet — an endpoint, a field, a filter, an event: write the request in docs/api-requests/ instead of inventing or faking the backend side.",
    body: [
      "# Writing an API request",
      "",
      "Path: `docs/api-requests/YYYY-MM-DD-<topic>.md`. The reader is the backend developer who",
      "will build it and did not see this work. Never implement the backend side from the",
      "client's repository, and never fake it silently.",
      "",
      "- **What is needed** — the endpoint, field, filter or event, in a few lines.",
      "- **Why** — the user-facing flow that needs it.",
      "- **Proposed contract** — method, path, request and response shape, errors, events;",
      "  mark it as a proposal the backend may change.",
      "- **Until it ships** — what the client does now: a mock, a feature flag, a hidden",
      "  control — and where in the code, so it can be removed.",
      "- **Existing API checked** — what was looked at and why it does not fit.",
      "",
      "Name the request in the pull request and in the handoff, if there is one.",
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
  "## Навички, призначені цій ролі\nНаведені повністю — не читай їх повторно через `skill://`.";

// Appended to a rendered instruction, so it opens with its own blank line: the caller
// concatenates and never has to know the shape. An empty assignment adds NOTHING — a bare
// heading would tell the agent to look for skills that are not there.
export function assignedBlock(defs: readonly SkillDef[]): string {
  if (defs.length === 0) return "";
  const bodies = defs.map((d) => `### ${d.name}\n${d.body.trim()}`).join("\n\n");
  return `\n\n${ASSIGNED_BLOCK_HEADER}\n\n${bodies}`;
}
