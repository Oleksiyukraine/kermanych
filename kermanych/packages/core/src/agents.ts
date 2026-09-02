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
  "are resolved, run `git add -A && git commit --no-edit` to complete the merge. Do only this.",
].join("");

const PULL_REQUEST = [
  "Open a pull request for this session's branch `{{branch}}`.\n\n",
  "Follow the repository's own `### PR Conventions` and `### Commit Conventions` from its ",
  "CLAUDE.md / AGENTS.md if they exist. If the repo defines none, follow these defaults instead:\n",
  "{{conventions}}\n\n",
  "Steps:\n",
  "1. Commit any uncommitted work, following the commit conventions.\n",
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

// A missing variable throws rather than shipping `{{diff}}` to a model: an unfilled hole is
// a bug that reads as a bizarre instruction, and it would be invisible until someone read
// the transcript.
export function renderInstruction(def: AgentDef, vars: Record<string, string>): string {
  if (!def.instruction) throw new Error(`agent "${def.id}" has no instruction to render`);
  return def.instruction.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`agent "${def.id}": missing value for {{${key}}}`);
    return value;
  });
}
