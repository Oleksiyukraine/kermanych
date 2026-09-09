// Kermanych's own agents: what they are and what they are told.
//
// The four instruction texts lived inline in supervisor.service.ts, where the settings
// catalogue could not read them without duplicating them. They live here so the text the
// operator sees and the text the agent receives are the same string.
//
// `kind` describes the agent, it does not switch behaviour: an assigned skill is delivered
// identically for all four (see SkillsService.assignedBlock).
//   session    — starts its own omp child
//   procedure  — sends a message into a child that is already running
//   automation — no model involved at all, so no instruction to show

export type AgentKind = "session" | "procedure" | "automation";

export type AgentDef = {
  id: string;
  /** i18n key for the operator-facing role name: `agents.role.<id>`. The UI renders it via `t()`. */
  labelKey: string;
  kind: AgentKind;
  /** The template, with `{{hole}}` placeholders. Absent for `automation`. */
  instruction?: string;
  /** Every hole the template uses. The catalogue renders the template as-is; the runtime fills these. */
  holes?: readonly string[];
};

// Kermanych's fallback PR/commit conventions, used when the project defines none. Moved here
// from supervisor.service.ts because it is part of the pull-request instruction.
export const PR_CONVENTIONS_FALLBACK = [
  "- Commits: Conventional Commits — `type(scope): summary` in the imperative mood (feat, fix, chore, refactor, docs, test).",
  "- PR title: the same Conventional-Commit style, summarising the whole change.",
  "- PR body: a `## Summary` section (what changed and why) and a `## Testing` section (commands run / how it was verified).",
  "- Keep the PR scoped to this branch's work; do not fold in unrelated changes.",
].join("\n");

// The identity Kermanych credits itself with when it drives work: a commit co-author, mirroring
// the runtime's own `Co-Authored-By: Claude …` line so a PR carries BOTH. A constant, not a
// runtime hole — who Kermanych is does not vary by project. This is the GitHub-provided no-reply
// address of the @kermanychsupport-ai account (`<id>+<login>@users.noreply.github.com`), which
// GitHub resolves to that account for the avatar without exposing a real inbox in every commit.
export const KERMANYCH_COAUTHOR = "Kermanych <327010303+kermanychsupport-ai@users.noreply.github.com>";

// Appended to every WORK session's opening prompt (SupervisorService.launch), so every commit
// the agent makes carries the co-author trailer — not only the ones a Kermanych template
// dictates. Deliberately one line: unlike a skill block, a single attribution trailer does not
// compete with the repository's own conventions, which is why a work session may carry it.
export const COAUTHOR_DIRECTIVE =
  "When you commit, end each commit message with a blank line followed by the trailer " +
  `\`Co-Authored-By: ${KERMANYCH_COAUTHOR}\`, crediting Kermanych as a co-author of the work.`;

const REVIEW = [
  "You are an INDEPENDENT code reviewer. You did NOT do this work and have no prior ",
  "context — audit ONLY the task and the diff below, with fresh eyes.\n\n",
  "## Original task\n{{task}}\n\n",
  "## Diff (base `{{base}}` → branch `{{branch}}`)\n",
  "```diff\n{{diff}}\n```\n\n",
  "Perform a FULL audit: does the change satisfy the task; are any requirements missed ",
  "or only partly done; are there bugs, edge cases, or security issues; are tests present ",
  "and meaningful; is the code sound? You may read any file in the worktree for context, ",
  "but you are read-only — do NOT modify anything or run commands. Finish with a clear ",
  "verdict (APPROVE or NEEDS CHANGES) and a prioritized list of findings.",
].join("");

const PROMOTE = [
  "The planning discussion above is settled — implement it now.\n\n",
  "You are no longer read-only: you have been moved out of the project directory into a ",
  "dedicated git worktree on branch `{{branch}}`, with the full toolset. Everything agreed ",
  "above is the specification — do not re-open it and do not re-ask what was already ",
  "answered.\n\n",
  "Implement it end to end: follow the repo's existing conventions and patterns, leave no ",
  "stubs or TODOs behind, and commit your work on this branch. Where the discussion left ",
  "something ambiguous, take the most reasonable reading, say which one you took, and keep ",
  "going — stop only for a genuinely blocking question.",
].join("");

const RESOLVE_CONFLICT = [
  "A git merge is in progress in this worktree with conflicts in:\n",
  "{{files}}",
  "\n\nResolve every conflict: edit each file, remove the conflict markers ",
  "(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ",
  "branch's changes AND the changes merged in from the base branch. When all conflicts ",
  `are resolved, run \`git add -A && git commit --no-edit --trailer "Co-Authored-By: ${KERMANYCH_COAUTHOR}"\` to complete the merge. Do only this.`,
].join("");

// The auth block is the load-bearing part: `gh pr create` and `git push` otherwise pick up
// whatever ambient credential the machine has (a stored `gh` login, an ssh key, a credential
// helper), which is often the wrong account. Kermanych copies the project's configured Git
// token into every worktree's `.env` as GIT_TOKEN for exactly this, so the agent is told to
// PREFER it and only fall back to ambient credentials when it is absent. Read without echoing:
// the token must never reach the transcript.
const PULL_REQUEST = [
  "Open a pull request for this session's branch `{{branch}}`.\n\n",
  "Follow the repository's own `### PR Conventions` and `### Commit Conventions` from its ",
  "CLAUDE.md / AGENTS.md if they exist. If the repo defines none, follow these defaults instead:\n",
  "{{conventions}}\n\n",
  "Authentication — settle this BEFORE pushing or opening the PR, and prefer it over any ",
  "ambient `gh`/git credentials, which may belong to the wrong account:\n",
  "1. Read `GIT_TOKEN` from the `.env` at the root of this worktree — Kermanych copies the ",
  "project's configured Git token there for exactly this. Load it WITHOUT printing it, e.g. ",
  "`export GH_TOKEN=\"$(grep -E '^GIT_TOKEN=' .env | head -n1 | cut -d= -f2-)\"`; never echo the ",
  "token or paste it into a command whose output is shown.\n",
  "2. If GH_TOKEN is now non-empty, make git use it too (`gh auth setup-git`) and do the push ",
  "and the PR with it. If `.env` has no `GIT_TOKEN`, or it is empty, fall back to the ",
  "environment's existing `gh`/git credentials.\n\n",
  "Steps:\n",
  "1. Commit any uncommitted work, following the commit conventions. End every commit message ",
  `you write with a blank line and the trailer \`Co-Authored-By: ${KERMANYCH_COAUTHOR}\`, so `,
  "GitHub credits Kermanych as a co-author of the PR — in addition to any co-author your ",
  "runtime already adds.\n",
  "2. Push `{{branch}}` to `origin` (set the upstream).\n",
  "3. Open the PR with `gh pr create`. {{baseLine}}\n",
  "Reply with the PR URL when done. Do only this.",
].join("");

export const AGENTS: readonly AgentDef[] = [
  { id: "review", labelKey: "agents.role.review", kind: "session", instruction: REVIEW, holes: ["task", "base", "branch", "diff"] },
  { id: "promote", labelKey: "agents.role.promote", kind: "session", instruction: PROMOTE, holes: ["branch"] },
  { id: "pull-request", labelKey: "agents.role.pull-request", kind: "procedure", instruction: PULL_REQUEST, holes: ["branch", "conventions", "baseLine"] },
  { id: "resolve-conflict", labelKey: "agents.role.resolve-conflict", kind: "procedure", instruction: RESOLVE_CONFLICT, holes: ["files"] },
  { id: "finish", labelKey: "agents.role.finish", kind: "automation" },
  { id: "summary", labelKey: "agents.role.summary", kind: "automation" },
];

export function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

// The hole grammar, in one place: the renderer that FILLS holes and the validator that
// audits an operator's rewrite must agree on what a hole is, or a template the editor
// accepted would blow up at launch. Sharing one global regex is safe: `matchAll` iterates a
// clone and `replace` resets `lastIndex`, so neither leaves state for the other.
const HOLE_RE = /\{\{(\w+)\}\}/g;

// Why hole validation is a domain function and not a check in the settings pane: the
// instruction is now editable per project, and both ways of getting it wrong are invisible
// at edit time. Drop a declared hole and the agent still runs, silently starved of the
// context it was written around — no diff, no branch — and answers confidently about
// nothing. Invent a hole and `renderInstruction` throws mid-session, when the operator is
// already waiting on the agent. So the editor and the launcher call the same two functions:
// the pane refuses to save a broken template, and the launcher refuses to use one that
// reached the database anyway (an older UI, a hand-written row).

/** Every `{{hole}}` a template uses, unique, in first-appearance order. */
export function instructionHoles(template: string): string[] {
  const seen = new Set<string>();
  const holes: string[] = [];
  for (const m of template.matchAll(HOLE_RE)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    holes.push(name);
  }
  return holes;
}

/** What is wrong with an operator-edited template, measured against the agent's declared holes. */
export function instructionErrors(def: AgentDef, template: string): { missing: string[]; unknown: string[] } {
  const declared = def.holes ?? [];
  const used = instructionHoles(template);
  const usedSet = new Set(used);
  return {
    missing: declared.filter((hole) => !usedSet.has(hole)),
    unknown: used.filter((hole) => !declared.includes(hole)),
  };
}

/** The template to render: a valid non-blank override, else the compile-time default (undefined for automations). */
export function effectiveInstruction(def: AgentDef, override?: string | null): string | undefined {
  if (!def.instruction) return undefined;
  const trimmed = override?.trim();
  if (!trimmed) return def.instruction;
  const { missing, unknown } = instructionErrors(def, trimmed);
  return missing.length > 0 || unknown.length > 0 ? def.instruction : trimmed;
}

// A missing variable throws rather than shipping `{{diff}}` to a model: an unfilled hole is
// a bug that reads as a bizarre instruction, and it would be invisible until someone read
// the transcript. `template` overrides the default text; the refusal to render an automation
// stays keyed on the AGENT, since what it lacks is a model to instruct, not a text to fill.
export function renderInstruction(def: AgentDef, vars: Record<string, string>, template?: string): string {
  if (!def.instruction) throw new Error(`agent "${def.id}" has no instruction to render`);
  const source = template ?? def.instruction;
  return source.replace(HOLE_RE, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`agent "${def.id}": missing value for {{${key}}}`);
    return value;
  });
}
