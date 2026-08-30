# «ШІ команда» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings surface that lists Kermanych's own agents with the instructions they are actually sent, lets a project assign skills to those agents (guaranteed delivery, not model discretion), and lets a project define triggers that fire a skill or an agent automatically.

**Architecture:** The four hard-coded prompts move from `supervisor.service.ts` into an `AGENTS` registry in `packages/core`, so the catalogue and the runtime read one text. Two new cloud tables hold per-project assignments and triggers. `SkillsService` resolves an assignment to skill bodies and appends them as a labelled block to the agent's own instruction — one contract at all four sites, no launch flags. Triggers split by source: `operator` is matched by Kermanych in `sendMessage`; `assistant`/`thinking`/`tool` become TTSR rules in a per-session extension package delivered with `-e`.

**Tech Stack:** TypeScript, NestJS (api), Quasar/Vue 3 (ui), Supabase/Postgres + RLS (cloud), vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-28-ai-team-agents-design.md` (read §2.6 before Task 6 — the trigger mechanics were probed, not assumed)

## Prerequisites

- **The worktree must be synced with `dev` before Task 1.** This plan cites `dev` at the settings-v2 and workspaces merges; a worktree that predates them has no `apps/ui/src/lib/settings.ts` and no `SettingsPage.vue`, so Tasks 7-10 have nothing to edit. Either start from a fresh session on current `dev` or merge `dev` into this branch first. **Line numbers below are from `dev` and will have moved — re-anchor by searching for the quoted code, never by trusting the number.**
- `cd kermanych && pnpm install && pnpm -r --filter "./packages/*" build` — `apps/api` and `apps/ui` import the packages from `dist/`.

## Global Constraints

- **Guaranteed, not discretionary.** An assigned skill is delivered inside the agent's instruction. A library skill is model-invoked. These are different mechanisms and the UI must never blur them.
- **One delivery contract.** All four instruction-bearing sites append the block through ONE helper. No `--skills`, no `--no-skills`, no `--append-system-prompt` — all three are deliberately unused (spec §2.5, §3.4).
- **The repository always wins.** Nothing here writes into the operator's worktree. Skill and rule names that the repository already defines are the repository's.
- **`projects.owner_id` no longer exists.** Every new policy copies the post-workspaces shape: read `public.is_project_member(project_id, auth.uid())`, write `exists (select 1 from public.projects p join public.workspaces w on w.id = p.workspace_id where p.id = project_id and w.owner_id = auth.uid())`.
- **No placeholders in settings.** `apps/ui/src/lib/settings.ts` states that every registered category is backed by a real read and a real write. No workspace-scoped row for agents, skills or triggers.
- **Barrels are explicit.** A symbol missing from `packages/core/src/index.ts` or `packages/cloud/src/index.ts` resolves to `undefined` in the bundled UI.
- **Trigger defaults are `mode: "remind"` and `repeat: "once"`.** The hard mode aborts a turn, discards partial output and still does not guarantee compliance (spec §2.6).
- **UI copy is Ukrainian; code, identifiers and the agent instructions are English.**
- **Skill names, agent ids and trigger ids all match `/^[a-z0-9][a-z0-9-]{0,63}$/`.**

---

### Task 1: The agent registry in `packages/core`

**Files:**
- Create: `kermanych/packages/core/src/agents.ts`
- Modify: `kermanych/packages/core/src/index.ts` (barrel)
- Test: `kermanych/packages/core/test/agents.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AgentKind = "session" | "procedure" | "automation"`;
  `type AgentDef = { id: string; label: string; kind: AgentKind; instruction?: string; holes?: readonly string[] }`;
  `const AGENTS: readonly AgentDef[]`; `agentById(id: string): AgentDef | undefined`;
  `renderInstruction(def: AgentDef, vars: Record<string, string>): string`;
  `const PR_CONVENTIONS_FALLBACK: string`.

- [ ] **Step 1: Write the failing test**

````ts
// kermanych/packages/core/test/agents.spec.ts
import { expect, test } from "vitest";
import { AGENTS, agentById, renderInstruction, PR_CONVENTIONS_FALLBACK } from "../src/agents";
import { SKILL_NAME_RE } from "../src/skills";

test("the registry describes six agents, four of them instruction-bearing", () => {
  expect(AGENTS.map((a) => a.id)).toEqual([
    "review", "promote", "pull-request", "resolve-conflict", "finish", "summary",
  ]);
  for (const a of AGENTS) {
    expect(SKILL_NAME_RE.test(a.id)).toBe(true);
    expect(a.label.trim()).not.toBe("");
  }
  expect(AGENTS.filter((a) => a.instruction).map((a) => a.id)).toEqual([
    "review", "promote", "pull-request", "resolve-conflict",
  ]);
  // `automation` means no model is involved, so there is nothing to display.
  for (const a of AGENTS.filter((a) => a.kind === "automation")) {
    expect(a.instruction).toBeUndefined();
    expect(a.holes).toBeUndefined();
  }
});

test("every hole in an instruction is declared, and every declared hole is used", () => {
  for (const a of AGENTS) {
    if (!a.instruction) continue;
    const used = [...a.instruction.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    expect(new Set(used)).toEqual(new Set(a.holes ?? []));
    expect(used.length).toBeGreaterThan(0);
  }
});

test("renderInstruction substitutes every hole and leaves no braces behind", () => {
  const out = renderInstruction(agentById("resolve-conflict")!, { files: "- a.ts\n- b.ts" });
  expect(out).toContain("- a.ts\n- b.ts");
  expect(out).not.toMatch(/\{\{/);
});

test("a missing variable is an error, not an unfilled hole in a live prompt", () => {
  expect(() => renderInstruction(agentById("review")!, { task: "t" })).toThrow(/base|branch|diff/);
});

test("an automation agent cannot be rendered", () => {
  expect(() => renderInstruction(agentById("finish")!, {})).toThrow(/finish/);
});

test("the PR conventions fallback is the four-line list the supervisor used", () => {
  expect(PR_CONVENTIONS_FALLBACK.split("\n")).toHaveLength(4);
  expect(PR_CONVENTIONS_FALLBACK).toContain("Conventional Commits");
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/agents.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/agents"`.

- [ ] **Step 3: Write the registry**

The four instructions are the CURRENT texts from `dev`'s `supervisor.service.ts` with their interpolations turned into `{{holes}}`. Copy them exactly — Task 2 asserts byte-equality against the old code, so a reworded sentence fails that test.

````ts
// kermanych/packages/core/src/agents.ts
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
  label: string;
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
  { id: "review", label: "Ревізор", kind: "session", instruction: REVIEW, holes: ["task", "base", "branch", "diff"] },
  { id: "promote", label: "Промоутер", kind: "session", instruction: PROMOTE, holes: ["branch"] },
  { id: "pull-request", label: "Провізор", kind: "procedure", instruction: PULL_REQUEST, holes: ["branch", "conventions", "baseLine"] },
  { id: "resolve-conflict", label: "Вирішувач конфліктів", kind: "procedure", instruction: RESOLVE_CONFLICT, holes: ["files"] },
  { id: "finish", label: "Завершити", kind: "automation" },
  { id: "summary", label: "Саммарі", kind: "automation" },
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
````

- [ ] **Step 4: Export from the barrel**

In `kermanych/packages/core/src/index.ts`, after the `./skills` export block, add:

```ts
export {
  AGENTS,
  PR_CONVENTIONS_FALLBACK,
  agentById,
  renderInstruction,
  type AgentDef,
  type AgentKind,
} from "./agents";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/agents.spec.ts && pnpm --filter @kermanych/core test`
Expected: PASS (6 new tests; the package suite stays green)

- [ ] **Step 6: Commit**

```bash
git add kermanych/packages/core/src/agents.ts kermanych/packages/core/src/index.ts kermanych/packages/core/test/agents.spec.ts
git commit -m "feat(core): agent registry with the instructions the supervisor sends"
```

---

### Task 2: The supervisor renders from the registry (no behaviour change)

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` — the `DEFAULT_PR_CONVENTIONS` constant (`:61-69`), and the four `const prompt =` sites (`:504`, `:734`, `:1048`, `:1076`)
- Test: `kermanych/apps/api/test/agent-instructions.spec.ts`

**Interfaces:**
- Consumes: `AGENTS`, `agentById`, `renderInstruction`, `PR_CONVENTIONS_FALLBACK` (Task 1).
- Produces: no new exports. The supervisor's four prompts are now rendered, not concatenated.

- [ ] **Step 1: Write the failing test**

This is a golden test: it pins the rendered text against the strings that are in the file TODAY, so the extraction cannot quietly reword a prompt.

````ts
// kermanych/apps/api/test/agent-instructions.spec.ts
import { expect, test } from "vitest";
import { agentById, renderInstruction, PR_CONVENTIONS_FALLBACK } from "@kermanych/core";

test("the review instruction is byte-identical to the text the supervisor used", () => {
  const out = renderInstruction(agentById("review")!, {
    task: "TASK", base: "dev", branch: "feature/x", diff: "DIFF",
  });
  expect(out).toBe(
    `You are an INDEPENDENT code reviewer. You did NOT do this work and have no prior ` +
      `context — audit ONLY the task and the diff below, with fresh eyes.\n\n` +
      `## Original task\nTASK\n\n` +
      `## Diff (base \`dev\` → branch \`feature/x\`)\n` +
      "```diff\nDIFF\n```\n\n" +
      `Perform a FULL audit: does the change satisfy the task; are any requirements missed ` +
      `or only partly done; are there bugs, edge cases, or security issues; are tests present ` +
      `and meaningful; is the code sound? You may read any file in the worktree for context, ` +
      `but you are read-only — do NOT modify anything or run commands. Finish with a clear ` +
      `verdict (APPROVE or NEEDS CHANGES) and a prioritized list of findings.`,
  );
});

test("the conflict instruction is byte-identical", () => {
  const out = renderInstruction(agentById("resolve-conflict")!, { files: "- a.ts\n- b.ts" });
  expect(out).toBe(
    `A git merge is in progress in this worktree with conflicts in:\n` +
      `- a.ts\n- b.ts` +
      `\n\nResolve every conflict: edit each file, remove the conflict markers ` +
      `(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ` +
      `branch's changes AND the changes merged in from the base branch. When all conflicts ` +
      `are resolved, run \`git add -A && git commit --no-edit\` to complete the merge. Do only this.`,
  );
});

test("the pull-request instruction keeps the conventions fallback and the base sentence", () => {
  const out = renderInstruction(agentById("pull-request")!, {
    branch: "feature/x",
    conventions: PR_CONVENTIONS_FALLBACK,
    baseLine: "Target the PR at `dev`, unless the repo's PR conventions dictate a different base.",
  });
  expect(out.startsWith("Open a pull request for this session's branch `feature/x`.")).toBe(true);
  expect(out).toContain(PR_CONVENTIONS_FALLBACK);
  expect(out).toContain("2. Push `feature/x` to `origin` (set the upstream).");
  expect(out.endsWith("Reply with the PR URL when done. Do only this.")).toBe(true);
});

test("the promote instruction keeps its branch hole", () => {
  const out = renderInstruction(agentById("promote")!, { branch: "feature/x" });
  expect(out).toContain("dedicated git worktree on branch `feature/x`, with the full toolset.");
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/agent-instructions.spec.ts`
Expected: FAIL until Task 1's build is picked up — run `pnpm -r --filter "./packages/*" build` first if the import does not resolve. If the assertions fail on whitespace, the template in Task 1 diverged from the original: fix the template, not the test.

- [ ] **Step 3: Replace the four inline prompts**

In `supervisor.service.ts`:

1. Delete the `DEFAULT_PR_CONVENTIONS` constant and import `PR_CONVENTIONS_FALLBACK` from `@kermanych/core` instead (same text; the name changes because it now belongs to the registry).
2. At the promote site (search for `The planning discussion above is settled`):

```ts
    const prompt = renderInstruction(agentById("promote")!, { branch });
```

3. At the review site (search for `You are an INDEPENDENT code reviewer`):

```ts
    const prompt = renderInstruction(agentById("review")!, {
      task: s.task, base, branch: s.branch, diff,
    });
```

4. At the conflict site (search for `A git merge is in progress`):

```ts
    const prompt = renderInstruction(agentById("resolve-conflict")!, {
      files: files.map((f) => `- ${f}`).join("\n"),
    });
```

5. At the PR site (search for `Open a pull request for this session's branch`), keep `baseHint`/`baseLine` exactly as they are and pass them in:

```ts
    const prompt = renderInstruction(agentById("pull-request")!, {
      branch: s.branch,
      conventions: (g.conventions || "").trim() || PR_CONVENTIONS_FALLBACK,
      baseLine,
    });
```

Import `agentById` and `renderInstruction` from `@kermanych/core` alongside the existing imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/agent-instructions.spec.ts test/supervisor.pr.spec.ts test/supervisor.review.spec.ts && pnpm --filter @kermanych/api test`
Expected: PASS. The two pre-existing supervisor suites assert on these prompts, so they are the real regression net here.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/agent-instructions.spec.ts
git commit -m "refactor(api): render agent instructions from the core registry"
```

---

### Task 3: Cloud tables and typed surfaces

**Files:**
- Create: `kermanych/supabase/migrations/20260828090000_ai_team.sql`
- Create: `kermanych/packages/cloud/src/agent-skills.ts`, `kermanych/packages/cloud/src/triggers.ts`
- Modify: `kermanych/packages/cloud/src/types.ts`, `kermanych/packages/cloud/src/index.ts`
- Test: `kermanych/packages/cloud/test/ai-team.spec.ts`, `kermanych/packages/cloud/test/rls.spec.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  `type AgentSkill = { projectId: string; agentId: string; skillName: string; position: number }`;
  `type ProjectTrigger = { projectId: string; id: string; label: string; enabled: boolean; source: TriggerSource; pattern: string; pathGlobs: string[]; action: "skill" | "agent"; target: string; mode: "remind" | "interrupt"; repeat: "once" | "after-gap" }`;
  `type TriggerSource = "operator" | "assistant" | "thinking" | "tool"`;
  `listAgentSkills(client, projectIds)`, `setAgentSkill(client, input)`, `deleteAgentSkill(client, projectId, agentId, skillName)`;
  `listTriggers(client, projectIds)`, `upsertTrigger(client, input)`, `deleteTrigger(client, projectId, id)`;
  plus `toAgentSkill` / `toTrigger` mappers.

- [ ] **Step 1: Write the failing mapper test**

````ts
// kermanych/packages/cloud/test/ai-team.spec.ts
import { expect, test } from "vitest";
import { toAgentSkill } from "../src/agent-skills";
import { toTrigger } from "../src/triggers";

test("an assignment row maps to camelCase", () => {
  expect(toAgentSkill({ project_id: "p1", agent_id: "review", skill_name: "how-we-review", position: 2 })).toEqual({
    projectId: "p1", agentId: "review", skillName: "how-we-review", position: 2,
  });
});

test("a trigger row maps, and an absent glob list becomes an empty array", () => {
  expect(
    toTrigger({
      project_id: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
      source: "thinking", pattern: "нову env|new env var", path_globs: null,
      action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once",
    }),
  ).toEqual({
    projectId: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
    source: "thinking", pattern: "нову env|new env var", pathGlobs: [],
    action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once",
  });
});

test("a tool-scoped trigger keeps its path globs", () => {
  const t = toTrigger({
    project_id: "p1", id: "wf", label: "Workflow", enabled: false, source: "tool",
    pattern: "set-env-vars", path_globs: [".github/workflows/*.yml"],
    action: "skill", target: "how-we-add-env", mode: "interrupt", repeat: "after-gap",
  });
  expect(t.pathGlobs).toEqual([".github/workflows/*.yml"]);
  expect(t.enabled).toBe(false);
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/cloud exec vitest run test/ai-team.spec.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Write the migration**

```sql
-- kermanych/supabase/migrations/20260828090000_ai_team.sql
-- «ШІ команда»: which skills a project assigns to Kermanych's agents, and which triggers
-- fire them. Both mirror project_skills: one row per fact, member reads, workspace-owner
-- writes, server-owned audit columns, and NOT in the realtime publication (both are read
-- when a session launches).

create table public.project_agent_skills (
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The id of an entry in packages/core's AGENTS registry. Deliberately not an enum: the
  -- registry is code and gains entries without a migration.
  agent_id   text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- A NAME, not a foreign key: a Kermanych default has no project_skills row at all, and
  -- assigning one must be possible. Resolution happens at launch.
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, agent_id, skill_name)
);

create table public.project_triggers (
  project_id uuid not null references public.projects(id) on delete cascade,
  id         text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label      text not null check (length(btrim(label, E' \t\r\n')) > 0),
  enabled    boolean not null default true,
  -- operator = matched by Kermanych before the message is forwarded;
  -- the rest = a TTSR rule inside the omp child.
  source     text not null check (source in ('operator', 'assistant', 'thinking', 'tool')),
  pattern    text not null check (length(btrim(pattern, E' \t\r\n')) > 0),
  path_globs text[],
  action     text not null check (action in ('skill', 'agent')),
  target     text not null check (target ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  mode       text not null default 'remind' check (mode in ('remind', 'interrupt')),
  repeat     text not null default 'once' check (repeat in ('once', 'after-gap')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, id),
  -- A child cannot call back into Kermanych, so only an operator-sourced trigger may run an
  -- agent. The editor blocks this too; the constraint is what makes it true.
  constraint project_triggers_agent_action_is_operator
    check (action <> 'agent' or source = 'operator')
);

alter table public.project_agent_skills enable row level security;
alter table public.project_triggers     enable row level security;
revoke all on public.project_agent_skills from anon;
revoke all on public.project_triggers     from anon;
grant select, insert, update, delete on public.project_agent_skills to authenticated;
grant select, insert, update, delete on public.project_triggers     to authenticated;

-- Read: any project member. Write: the workspace owner. Same predicates the workspaces
-- migration left on project_skills.
create policy project_agent_skills_select_member on public.project_agent_skills
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_agent_skills_insert_owner on public.project_agent_skills
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agent_skills_update_owner on public.project_agent_skills
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agent_skills_delete_owner on public.project_agent_skills
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_select_member on public.project_triggers
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_triggers_insert_owner on public.project_triggers
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_update_owner on public.project_triggers
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_delete_owner on public.project_triggers
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

-- Server-owned audit columns, following project_skills_touch().
create or replace function public.ai_team_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_agent_skills_touch
  before insert or update on public.project_agent_skills
  for each row execute function public.ai_team_touch();

create trigger project_triggers_touch
  before insert or update on public.project_triggers
  for each row execute function public.ai_team_touch();
```

- [ ] **Step 4: Write the two typed modules**

Append to `kermanych/packages/cloud/src/types.ts`:

```ts
/** One skill assigned to one Kermanych agent, for one project. */
export type AgentSkill = {
  projectId: string;
  agentId: string;
  skillName: string;
  position: number;
};

export type AgentSkillInsert = { projectId: string; agentId: string; skillName: string; position?: number };

export type TriggerSource = "operator" | "assistant" | "thinking" | "tool";

/** A rule that fires a skill or an agent without the model choosing to. */
export type ProjectTrigger = {
  projectId: string;
  id: string;
  label: string;
  enabled: boolean;
  source: TriggerSource;
  pattern: string;
  pathGlobs: string[];
  action: "skill" | "agent";
  target: string;
  mode: "remind" | "interrupt";
  repeat: "once" | "after-gap";
};

export type ProjectTriggerInsert = Omit<ProjectTrigger, "pathGlobs" | "enabled"> & {
  pathGlobs?: string[];
  enabled?: boolean;
};
```

Create `kermanych/packages/cloud/src/agent-skills.ts` and `kermanych/packages/cloud/src/triggers.ts` following `src/skills.ts` exactly: an explicit `*_COLUMNS` string, a `Row` type, a `toX` mapper that omits nothing and normalises `null` arrays to `[]`, thrown postgrest messages, an empty-`projectIds` guard returning `[]`, and `.select(...).single()` after every write. `setAgentSkill` and `upsertTrigger` use `upsert` with `onConflict: "project_id,agent_id,skill_name"` and `"project_id,id"` respectively. `deleteAgentSkill` and `deleteTrigger` request the removed rows with `.select(...)` and throw when none came back — the same asymmetry fix `deleteProjectSkill` carries.

- [ ] **Step 5: Export from the barrel**

Add the six functions, the two mappers and the five types to `kermanych/packages/cloud/src/index.ts`.

- [ ] **Step 6: Run the mapper tests**

Run: `cd kermanych && pnpm --filter @kermanych/cloud exec vitest run test/ai-team.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Add the RLS cases**

Append to `kermanych/packages/cloud/test/rls.spec.ts`, reusing its existing owner/member/outsider helpers and its env gate: the workspace owner can assign a skill and create a trigger; a member reads both; a member's write to either is refused; an outsider sees zero rows; `updated_by` is stamped; and an `action: 'agent'` trigger with `source: 'thinking'` is refused by the check constraint.

Run: `cd kermanych && pnpm --filter @kermanych/cloud test`
Expected: unit green, RLS suite SKIPPED (no local stack here — do not start Docker).

- [ ] **Step 8: Commit**

```bash
git add kermanych/supabase/migrations/20260828090000_ai_team.sql kermanych/packages/cloud/src kermanych/packages/cloud/test
git commit -m "feat(cloud): agent assignments and triggers"
```

---

### Task 4: Assignment resolution and the delivery block

**Files:**
- Modify: `kermanych/packages/core/src/skills.ts` (add `assignedBlock`), `kermanych/packages/core/src/index.ts`
- Modify: `kermanych/apps/api/src/skills/skills.service.ts` (add `assignedFor`)
- Test: `kermanych/packages/core/test/skills.spec.ts` (append), `kermanych/apps/api/test/skills.assignments.spec.ts`

**Interfaces:**
- Consumes: `resolveSkills`, `repoSkillNames`, `SkillsService.readRows` (existing); `listAgentSkills`, `AgentSkill` (Task 3).
- Produces: `assignedBlock(defs: readonly SkillDef[]): string` and `ASSIGNED_BLOCK_HEADER` in core;
  `SkillsService.assignedFor(projectId: string, agentId: string, cwd: string): Promise<{ block: string; view: SkillView[]; missing: string[] }>`.

**Deliberate refinement of the spec:** §4 puts the block builder in `SkillsService`. It goes in `packages/core/src/skills.ts` instead, beside `renderSkillFile`, because it is pure text assembly and the UI needs the same header string for its explainer. Precedence and I/O stay in `SkillsService`, which is what that boundary exists to protect.

- [ ] **Step 1: Write the failing tests**

````ts
// append to kermanych/packages/core/test/skills.spec.ts
import { assignedBlock, ASSIGNED_BLOCK_HEADER } from "../src/skills";

test("the assigned block names its skills and tells the agent not to re-read them", () => {
  const out = assignedBlock([
    { name: "how-we-review", description: "d", body: "Body one.\n" },
    { name: "how-we-add-env", description: "d", body: "Body two." },
  ]);
  expect(out).toContain(ASSIGNED_BLOCK_HEADER);
  expect(out).toContain("skill://");
  expect(out).toContain("### how-we-review\nBody one.");
  expect(out).toContain("### how-we-add-env\nBody two.");
  expect(out.indexOf("how-we-review")).toBeLessThan(out.indexOf("how-we-add-env"));
});

test("no assigned skills means no block at all, not an empty heading", () => {
  expect(assignedBlock([])).toBe("");
});
````

````ts
// kermanych/apps/api/test/skills.assignments.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS } from "@kermanych/core";
import type { AgentSkill, ProjectSkill } from "@kermanych/cloud";
import { SkillsService } from "../src/skills/skills.service";

const P = "11111111-1111-4111-8111-111111111111";
const assign = (skillName: string, position = 0): AgentSkill =>
  ({ projectId: P, agentId: "review", skillName, position });
const row = (p: Partial<ProjectSkill> & { name: string }): ProjectSkill =>
  ({ projectId: P, description: "d", body: "b", enabled: true, updatedAt: "t", ...p });

function service(assignments: AgentSkill[], library: ProjectSkill[]): SkillsService {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readAssignments = async () => assignments;
  svc.readRows = async () => library;
  return svc;
}

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-assign-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-assign-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("order follows position, then name", async () => {
  const svc = service(
    [assign("b-skill", 1), assign("a-skill", 1), assign("first", 0)],
    [row({ name: "a-skill", body: "A" }), row({ name: "b-skill", body: "B" }), row({ name: "first", body: "F" })],
  );
  const { block } = await svc.assignedFor(P, "review", repo);
  expect(block.indexOf("### first")).toBeLessThan(block.indexOf("### a-skill"));
  expect(block.indexOf("### a-skill")).toBeLessThan(block.indexOf("### b-skill"));
});

test("a Kermanych default is assignable with no cloud row, and its own body is used", async () => {
  const def = DEFAULT_SKILLS[0]!;
  const svc = service([assign(def.name)], []);
  const { block, view, missing } = await svc.assignedFor(P, "review", repo);
  expect(missing).toEqual([]);
  expect(block).toContain(def.body.split("\n")[0]!);
  expect(view[0]).toMatchObject({ name: def.name, source: "default" });
});

test("a project row overriding that name supplies the body instead", async () => {
  const def = DEFAULT_SKILLS[0]!;
  const svc = service([assign(def.name)], [row({ name: def.name, body: "PROJECT BODY" })]);
  const { block, view } = await svc.assignedFor(P, "review", repo);
  expect(block).toContain("PROJECT BODY");
  expect(view[0]).toMatchObject({ source: "project" });
});

test("a repository-defined name wins, and the view says where from", async () => {
  mkdirSync(join(repo, ".claude/skills/how-we-review"), { recursive: true });
  writeFileSync(
    join(repo, ".claude/skills/how-we-review/SKILL.md"),
    "---\nname: how-we-review\ndescription: repo\n---\nREPO BODY\n",
  );
  const svc = service([assign("how-we-review")], [row({ name: "how-we-review", body: "CLOUD BODY" })]);
  const { block, view } = await svc.assignedFor(P, "review", repo);
  expect(block).toContain("REPO BODY");
  expect(block).not.toContain("CLOUD BODY");
  expect(view[0]?.shadowedByRepo).toBe(join(repo, ".claude/skills/how-we-review/SKILL.md"));
});

test("a name that resolves to nothing is reported, not silently dropped", async () => {
  const svc = service([assign("deleted-skill")], []);
  const { block, missing } = await svc.assignedFor(P, "review", repo);
  expect(missing).toEqual(["deleted-skill"]);
  expect(block).toBe("");
});

test("an agent with no assignments gets no block, and an unknown id does not throw", async () => {
  const svc = service([assign("a-skill")], [row({ name: "a-skill" })]);
  expect((await svc.assignedFor(P, "pull-request", repo)).block).toBe("");
  expect((await svc.assignedFor(P, "not-an-agent", repo)).block).toBe("");
});

test("an unreachable cloud degrades to no block instead of failing the launch", async () => {
  const svc = service([], []);
  svc.readAssignments = async () => { throw new Error("offline"); };
  await expect(svc.assignedFor(P, "review", repo)).resolves.toEqual({ block: "", view: [], missing: [] });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts`
Expected: FAIL — `assignedBlock is not a function`.

- [ ] **Step 3: Implement `assignedBlock` in core**

```ts
// append to kermanych/packages/core/src/skills.ts
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

export function assignedBlock(defs: readonly SkillDef[]): string {
  if (defs.length === 0) return "";
  const bodies = defs.map((d) => `### ${d.name}\n${d.body.trim()}`).join("\n\n");
  return `\n\n${ASSIGNED_BLOCK_HEADER}\n\n${bodies}`;
}
```

Add both names to the `./skills` export block in the barrel.

- [ ] **Step 4: Implement `assignedFor` in the service**

```ts
// in kermanych/apps/api/src/skills/skills.service.ts
  // Seam for tests, mirroring readRows.
  readAssignments = async (projectId: string): Promise<AgentSkill[]> =>
    listAgentSkills(this.auth.cloudClient(), [projectId]);

  /**
   * The block an agent's instruction carries, plus the view the UI labels rows with and the
   * names that resolved to nothing. Never throws for a library reason: an agent that cannot
   * read its assignments still runs with its own instruction.
   */
  async assignedFor(projectId: string, agentId: string, cwd: string): Promise<{ block: string; view: SkillView[]; missing: string[] }> {
    assertProjectId(projectId);
    let rows: AgentSkill[] = [];
    try {
      rows = (await this.readAssignments(projectId)).filter((r) => r.agentId === agentId);
    } catch {
      return { block: "", view: [], missing: [] };
    }
    rows.sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
    const [library, repo] = await Promise.all([
      this.readRows(projectId).catch(() => []),
      repoSkillNames(cwd),
    ]);
    const resolved = new Map(resolveSkills(library).map((r) => [r.def.name, r]));
    const defs: SkillDef[] = [];
    const view: SkillView[] = [];
    const missing: string[] = [];
    for (const row of rows) {
      const hit = resolved.get(row.skillName);
      const repoPath = repo.get(row.skillName);
      if (!hit && !repoPath) { missing.push(row.skillName); continue; }
      // The repository's own file wins the name, so its text is what the agent must be given.
      const def = repoPath ? await readRepoSkill(repoPath, row.skillName) : hit!.def;
      if (!def) { missing.push(row.skillName); continue; }
      defs.push(def);
      view.push({
        name: def.name, description: def.description,
        source: hit?.source ?? "project",
        ...(repoPath ? { shadowedByRepo: repoPath } : {}),
      });
    }
    return { block: assignedBlock(defs), view, missing };
  }
```

`readRepoSkill(path, name)` is a new private helper in the same file: read the file, strip the frontmatter, return `{ name, description, body }`, and return `undefined` on any read failure (a repository file that cannot be read is a `missing` entry, not a crash).

- [ ] **Step 5: Wire the four sites**

In `supervisor.service.ts`, each of the four instruction sites appends the block. The review site, for example:

```ts
    const { block } = await this.skills.assignedFor(s.projectId, "review", cwd);
    const prompt = renderInstruction(agentById("review")!, { task: s.task, base, branch: s.branch, diff }) + block;
```

Do the same at `promote` (cwd = the project dir), `pull-request` and `resolve-conflict` (cwd = `s.worktreePath || g.localRepoPath`). All four go through `assignedFor` + `+ block` — no other shape.

- [ ] **Step 6: Run tests**

Run: `cd kermanych && pnpm -r --filter "./packages/*" build && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts && pnpm --filter @kermanych/api exec vitest run test/skills.assignments.spec.ts && pnpm --filter @kermanych/api test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add kermanych/packages/core/src kermanych/packages/core/test kermanych/apps/api/src kermanych/apps/api/test
git commit -m "feat(api): deliver assigned skills inside the agent's instruction"
```

---

### Task 5: Triggers — the TTSR package and operator matching

**Files:**
- Modify: `kermanych/apps/api/src/skills/skills.service.ts` (trigger materialisation)
- Modify: `kermanych/apps/api/src/rpc/rpc-session.ts` (`-e`)
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (`sendMessage` matching, pass the package at the launch sites)
- Test: `kermanych/apps/api/test/triggers.spec.ts`, `kermanych/apps/api/test/rpc-session.config.spec.ts` (append)

**Interfaces:**
- Consumes: `listTriggers`, `ProjectTrigger` (Task 3); `skillsRoot`, `resolveSkills`, `repoSkillNames` (existing).
- Produces: `triggersRoot(): string`; `renderRuleFile(t: ProjectTrigger, body: string): string`;
  `SkillsService.materializeTriggers(projectId, sessionId, cwd): Promise<{ packagePath?: string }>`;
  `SkillsService.operatorTriggers(projectId): Promise<ProjectTrigger[]>`;
  `RpcSessionOpts.extensionPath?: string` → `-e <path>`.

**Read `docs/superpowers/specs/2026-08-28-ai-team-agents-design.md` §2.6 first.** Every mapping below was probed against a real `omp` child; the frontmatter key names and the `scope` shape are not guesses.

- [ ] **Step 1: Write the failing tests**

````ts
// kermanych/apps/api/test/triggers.spec.ts
import { expect, test } from "vitest";
import { renderRuleFile } from "../src/skills/skills.service";
import type { ProjectTrigger } from "@kermanych/cloud";

const t = (over: Partial<ProjectTrigger>): ProjectTrigger => ({
  projectId: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
  source: "thinking", pattern: "new env var", pathGlobs: [],
  action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once", ...over,
});

test("a thinking trigger becomes a rule scoped to thinking, soft by default", () => {
  const out = renderRuleFile(t({}), "Body.");
  expect(out).toContain('condition: "new env var"');
  expect(out).toContain("scope: [thinking]");
  expect(out).toContain("interruptMode: never");
  expect(out).toContain("repeatMode: once");
  expect(out.trimEnd().endsWith("Body.")).toBe(true);
});

test("assistant and tool sources map to their own scopes, and globs ride along", () => {
  expect(renderRuleFile(t({ source: "assistant" }), "B")).toContain("scope: [text]");
  const tool = renderRuleFile(t({ source: "tool", pathGlobs: [".github/workflows/*.yml"] }), "B");
  expect(tool).toContain("scope: [tool]");
  expect(tool).toContain('globs: [".github/workflows/*.yml"]');
});

test("the hard mode is opt-in and maps to always", () => {
  expect(renderRuleFile(t({ mode: "interrupt", repeat: "after-gap" }), "B")).toContain("interruptMode: always");
  expect(renderRuleFile(t({ mode: "interrupt", repeat: "after-gap" }), "B")).toContain("repeatMode: after-gap");
});

test("a pattern with YAML-hostile characters survives", () => {
  const out = renderRuleFile(t({ pattern: "env: #prod" }), "B");
  expect(out).toContain('condition: "env: #prod"');
});
````

Plus, in the same file, cases for `materializeTriggers` against a temp `KERMANYCH_SKILLS_HOME`: it writes `package.json` with an `omp.extensions` entry, a no-op `index.js` and one `rules/<id>.md` per non-operator enabled trigger; an operator-sourced trigger produces no rule file; a disabled trigger produces none; a trigger whose `target` resolves to nothing produces none; the returned `packagePath` is absent when there is nothing to write.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/triggers.spec.ts`
Expected: FAIL — `renderRuleFile` is not exported.

- [ ] **Step 3: Implement the rule renderer and the package**

```ts
// in kermanych/apps/api/src/skills/skills.service.ts

// TTSR monitors assistant text and tool arguments by default and thinking only when the
// scope says so — which is why a "the model is reasoning about X" trigger MUST name it.
const TRIGGER_SCOPE: Record<Exclude<ProjectTrigger["source"], "operator">, string> = {
  assistant: "[text]",
  thinking: "[thinking]",
  tool: "[tool]",
};

export function triggersRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "triggers");
}

/**
 * A TTSR rule file. Every value is JSON-encoded, which is valid YAML and survives a pattern
 * containing `:` or `#` — a malformed rule is a hard omp startup error, not a degradation.
 */
export function renderRuleFile(t: ProjectTrigger, body: string): string {
  if (t.source === "operator") throw new Error(`trigger "${t.id}" is operator-sourced: it has no rule file`);
  const fm = [
    "---",
    `description: ${JSON.stringify(t.label)}`,
    `condition: ${JSON.stringify(t.pattern)}`,
    `scope: ${TRIGGER_SCOPE[t.source]}`,
    `interruptMode: ${t.mode === "interrupt" ? "always" : "never"}`,
    `repeatMode: ${t.repeat === "after-gap" ? "after-gap" : "once"}`,
    ...(t.pathGlobs.length ? [`globs: ${JSON.stringify(t.pathGlobs)}`] : []),
    "---",
  ].join("\n");
  return `${fm}\n\n${body.trim()}\n`;
}
```

```ts
  // Seam for tests, like readRows/readAssignments.
  readTriggers = async (projectId: string): Promise<ProjectTrigger[]> =>
    listTriggers(this.auth.cloudClient(), [projectId]);

  /**
   * Lay this session's TTSR rules out as a loadable extension package. Per SESSION, not per
   * project: a rule body may carry session-specific interpolation, and the per-project config
   * overlay already taught us that a shared filename with cwd-dependent content races.
   *
   * Never throws: a session that cannot have triggers still launches without them.
   */
  async materializeTriggers(projectId: string, sessionId: string, cwd: string): Promise<{ packagePath?: string }> {
    assertProjectId(projectId);
    // The session id becomes a directory name, so it gets the same check the project id gets.
    if (!isSkillName(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    const dir = join(triggersRoot(), sessionId);
    let triggers: ProjectTrigger[];
    try {
      triggers = (await this.readTriggers(projectId)).filter((t) => t.enabled && t.source !== "operator");
    } catch {
      return {};
    }
    // A trigger's body is the text it fires. `action: "skill"` resolves through the same
    // three-level precedence as an assignment; `action: "agent"` cannot occur here (the DB
    // constraint restricts it to operator-sourced rows) and is skipped if an older row has it.
    const bodies = new Map<string, string>();
    for (const t of triggers) {
      if (t.action !== "skill") continue;
      const { block } = await this.assignedForNames(projectId, [t.target], cwd);
      if (block.trim()) bodies.set(t.id, block.trim());
    }
    if (bodies.size === 0) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return {};
    }
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: `kermanych-triggers-${sessionId}`, version: "0.0.0", omp: { extensions: ["./index.js"] } }, null, 2),
      "utf8",
    );
    // A package is only loaded when its entry point resolves, and the sibling `rules/`
    // directory is only discovered for a loaded package. Hence a no-op extension.
    await writeFile(join(dir, "index.js"), "export default function () {}\n", "utf8");
    for (const t of triggers) {
      const body = bodies.get(t.id);
      if (body) await writeFile(join(dir, "rules", `${t.id}.md`), renderRuleFile(t, body), "utf8");
    }
    for (const e of await readEntries(join(dir, "rules"))) {
      if (e.isFile() && !bodies.has(e.name.replace(/\.md$/, ""))) {
        await rm(join(dir, "rules", e.name), { force: true }).catch(() => {});
      }
    }
    return { packagePath: dir };
  }
```

`assignedForNames(projectId, names, cwd)` is `assignedFor`'s body with the assignment read
replaced by an explicit name list — extract it in Task 4 and call it from both, so the
three-level resolution exists once.

Also extend the config overlay the library already writes so it carries `ttsr:\n  enabled: true` — an operator with TTSR switched off would otherwise get triggers that silently do nothing.

- [ ] **Step 4: Add `-e` to the argv**

In `rpc-session.ts`, add `extensionPath?: string` to the options type and, immediately after the `--config` line:

```ts
    // The session's trigger package (TTSR rules). Launch-time only, like --config.
    if (this.opts.extensionPath) argv.push("-e", this.opts.extensionPath);
```

Append a case to `test/rpc-session.config.spec.ts` asserting the full argv order with `configPath`, `extensionPath`, `model` and `tools` all set.

- [ ] **Step 5: Wire the supervisor**

1. At each `new RpcSession(` site, call `materializeTriggers(projectId, sessionId, cwd)` next to the existing `ompSkills(...)` and pass `extensionPath` when present.
2. In `sendMessage(id, text, mode, images)`, before forwarding, match the operator-sourced triggers:

```ts
    // Operator-sourced triggers run BEFORE the message reaches the child: Kermanych is the
    // only party that sees the operator's text, and an `agent` action has to be Kermanych's
    // to perform — a child cannot call back into us.
    const fired = await this.matchOperatorTriggers(s, text);
```

`matchOperatorTriggers` returns the trigger it fired, if any, and:
- for `action: "skill"` — prepends the resolved skill block to `text` and forwards as usual;
- for `action: "agent"` — **replaces** the message: it appends a notice entry to the transcript naming the trigger and the agent, invokes that agent's method, and does not forward the operator's text (the agent's own instruction is the message, and forwarding both would say the same thing twice).

Both paths are recorded in the transcript, so a fired trigger is never invisible.

- [ ] **Step 6: Run tests**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/triggers.spec.ts test/rpc-session.config.spec.ts && pnpm --filter @kermanych/api test`
Expected: PASS

- [ ] **Step 7: The env-gated end-to-end test**

Add to `kermanych/apps/api/test/skills.e2e.spec.ts` (the existing `describe.skipIf(!gated)` block) the case the spec calls the standing version of its probe: materialise a `thinking`-scoped trigger, launch a real child with both `--config` and `-e`, prompt it to reason about the pattern, and assert an injected `<system-interrupt … rule="<id>" …>` arrives whose `path` is under `triggersRoot()`.

Run: `cd kermanych && KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts`
Expected: PASS — the delivery chain (materialise → `-e` → `omp-plugins` → `TtsrManager`) is the one thing no unit test can prove.

- [ ] **Step 8: Commit**

```bash
git add kermanych/apps/api/src kermanych/apps/api/test
git commit -m "feat(api): fire triggers from Kermanych and from TTSR rules"
```

---

### Task 6: Move the skills library into settings

**Files:**
- Move: `kermanych/apps/ui/src/pages/ManagementSkillsPage.vue` → `kermanych/apps/ui/src/components/settings/SkillsLibraryPanel.vue`
- Modify: `kermanych/apps/ui/src/lib/management.ts` (remove the row), `kermanych/apps/ui/src/router/routes.ts` (remove the `SECTION_PAGES` entry)
- Modify: `kermanych/apps/ui/src/lib/settings.ts` (four new rows), `kermanych/apps/ui/src/pages/SettingsPage.vue` (four panes)
- Test: `kermanych/apps/ui/test/settings.spec.ts`

**Interfaces:**
- Consumes: the panel's existing props `{ projectId: string; projectName: string }`.
- Produces: the categories `project-skills`, `project-agents`, `project-triggers`, `app-agents`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/ui/test/settings.spec.ts
import { expect, test } from 'vitest';
import { SETTINGS_CATEGORIES, settingsSection, settingsScopeEntry } from '../src/lib/settings';

test('the AI-team rows exist at the scopes that have something behind them', () => {
  const keys = SETTINGS_CATEGORIES.map((c) => c.key);
  expect(keys).toContain('app-agents');
  expect(keys).toContain('project-agents');
  expect(keys).toContain('project-skills');
  expect(keys).toContain('project-triggers');
  // No workspace row: nothing is stored at that scope, and this file forbids placeholders.
  expect(SETTINGS_CATEGORIES.filter((c) => c.scope === 'workspace').map((c) => c.key))
    .not.toContain('workspace-agents');
});

test('the two ШІ команда rows are told apart by their sub-line, not their label', () => {
  const app = settingsSection('app-agents');
  const project = settingsSection('project-agents');
  expect(app.label).toBe(project.label);
  expect(app.sub).not.toBe(project.sub);
  expect(app.scope).toBe('app');
  expect(project.scope).toBe('project');
});

test('every scope still lands on a real category', () => {
  for (const scope of ['project', 'workspace', 'app'] as const) {
    expect(settingsScopeEntry(scope).scope).toBe(scope);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/ui exec vitest run test/settings.spec.ts`
Expected: FAIL — the four keys are absent.

- [ ] **Step 3: Register the categories**

In `apps/ui/src/lib/settings.ts`, add to `SETTINGS_CATEGORIES` — the project rows after `project-commands`, the app row after `app-general`:

```ts
  {
    key: 'project-agents',
    scope: 'project',
    label: 'ШІ команда',
    sub: 'що доручено на цьому проєкті',
    blurb: 'Які скіли отримують агенти Керманича, коли працюють у цьому проєкті.',
  },
  {
    key: 'project-skills',
    scope: 'project',
    label: 'Бібліотека скілів',
    sub: 'знання для агентів',
    blurb: 'Тексти, які агент бере сам, коли вважає за потрібне. Скіл із таким же імʼям у репозиторії завжди перемагає.',
  },
  {
    key: 'project-triggers',
    scope: 'project',
    label: 'Тригери',
    sub: 'коли вмикається саме',
    blurb: 'Що має спрацювати без рішення моделі — на слова оператора, на її власні розмірковування або на виклик інструмента.',
  },
  {
    key: 'app-agents',
    scope: 'app',
    label: 'ШІ команда',
    sub: 'хто в команді й що їм сказано',
    blurb: 'Агенти, яких Керманич запускає сам, і справжні інструкції, які вони отримують.',
  },
```

- [ ] **Step 4: Move the library panel and drop the Менеджмент entry**

```bash
cd kermanych && mkdir -p apps/ui/src/components/settings
git mv apps/ui/src/pages/ManagementSkillsPage.vue apps/ui/src/components/settings/SkillsLibraryPanel.vue
```

Then: remove the `management-skills` row from `apps/ui/src/lib/management.ts`, remove its entry from `SECTION_PAGES` in `apps/ui/src/router/routes.ts`, and fix the panel's own relative imports (it moves one directory deeper: `../lib/api` becomes `../../lib/api`, and its kit imports use the `components/kit/...` alias already used by `SettingsPage.vue`).

- [ ] **Step 5: Mount the library pane — and only that one**

In `SettingsPage.vue`, add ONE `v-else-if` pane to the existing chain, mounting the panel as a
component rather than inlining a form (the file is already 1777 lines, and `KEnvEditor` in the
`project-env` pane is the precedent):

```html
        <!-- ── PROJECT · БІБЛІОТЕКА СКІЛІВ ──────────────────────────────────── -->
        <div v-else-if="section.key === 'project-skills'" class="set__form set__form--wide">
          <p v-if="!projectId" class="set__note">{{ BIND_HINT }}</p>
          <SkillsLibraryPanel v-else :project-id="projectId" :project-name="selectedName" />
        </div>
```

The other three panes are added by the tasks that create their panels — Task 7 (`app-agents`),
Task 8 (`project-agents`), Task 9 (`project-triggers`). **Do not add a placeholder pane or a
stub component for them here.** A registered category with an empty pane is exactly what
`lib/settings.ts` forbids, and the three rows registered in Step 3 render their `blurb` with no
body until their task lands — which is honest and visibly unfinished, unlike a stub that looks
deliberate.

- [ ] **Step 6: Verify**

Run: `cd kermanych && pnpm --filter @kermanych/ui exec vitest run test/settings.spec.ts && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/ui typecheck`
Expected: PASS, no type errors. (`apps/api` must be built or `electron-main.ts` reports a missing `@kermanych/api`.)

- [ ] **Step 7: Commit**

```bash
git add -A kermanych/apps/ui
git commit -m "feat(ui): move the skill library into settings and register the AI-team rows"
```

---

### Task 7: The agent catalogue panel

**Files:**
- Create: `kermanych/apps/ui/src/components/settings/AgentCatalogPanel.vue`
- Modify: `kermanych/apps/ui/src/pages/SettingsPage.vue` (add the `app-agents` pane), `kermanych/apps/ui/src/lib/settings.ts` (the kind label)
- Test: `kermanych/apps/ui/test/agents-view.spec.ts`

**Interfaces:**
- Consumes: `AGENTS`, `type AgentDef` from `@kermanych/core`.
- Produces: `agentKindLabel(kind: AgentKind): string` in `apps/ui/src/lib/settings.ts` (pure, so it is the testable half).

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/ui/test/agents-view.spec.ts
import { expect, test } from 'vitest';
import { AGENTS } from '@kermanych/core';
import { agentKindLabel } from '../src/lib/settings';

test('every kind has a Ukrainian label, and they differ', () => {
  const labels = ['session', 'procedure', 'automation'].map((k) => agentKindLabel(k as never));
  expect(new Set(labels).size).toBe(3);
  for (const l of labels) expect(l.trim()).not.toBe('');
});

test('the catalogue can render every registry entry: four with a template, two without', () => {
  expect(AGENTS.filter((a) => a.instruction)).toHaveLength(4);
  expect(AGENTS.filter((a) => !a.instruction).every((a) => a.kind === 'automation')).toBe(true);
});
```

- [ ] **Step 2: Run it, see it fail** (`agentKindLabel` is not exported), then implement:

```ts
// in apps/ui/src/lib/settings.ts
/** What each agent kind means for an operator reading the catalogue. */
export function agentKindLabel(kind: AgentKind): string {
  return kind === 'session' ? 'власна сесія' : kind === 'procedure' ? 'доручення в поточну сесію' : 'без ШІ';
}
```

- [ ] **Step 3: Write the panel**

Read-only. For each entry in `AGENTS`: the label, a badge carrying `agentKindLabel(a.kind)`, and — when `a.instruction` exists — the template verbatim in a monospace block, with its `{{holes}}` left visible. No translation and no paraphrase: the English text is what the model receives, and a Ukrainian version beside it would be a second source of truth. An `automation` entry renders the badge and one muted line saying there is no instruction because no model is involved. A short lead paragraph explains the three kinds in one sentence each.

- [ ] **Step 4: Verify**

Run: `cd kermanych && pnpm --filter @kermanych/ui exec vitest run test/agents-view.spec.ts && pnpm --filter @kermanych/ui typecheck`

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui
git commit -m "feat(ui): the read-only agent catalogue"
```

---

### Task 8: The assignment board

**Files:**
- Create: `kermanych/apps/ui/src/components/settings/AgentSkillsPanel.vue`
- Modify: `kermanych/apps/ui/src/pages/SettingsPage.vue` (add the `project-agents` pane), `kermanych/apps/ui/src/lib/settings.ts` (the pure merge)
- Test: `kermanych/apps/ui/test/assignments.spec.ts`

**Interfaces:**
- Consumes: `AGENTS`, `ASSIGNED_BLOCK_HEADER` from `@kermanych/core`; `listAgentSkills`, `setAgentSkill`, `deleteAgentSkill`, `listProjectSkills` from `@kermanych/cloud`; `api.projectSkills(id)` for the resolved view and its source badges.
- Produces: `assignmentRows(agents, assignments, view, bodyBytes)` and `type AssignmentRow` in `apps/ui/src/lib/settings.ts` — the pure merge the panel renders and the test drives.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/ui/test/assignments.spec.ts
import { expect, test } from 'vitest';
import { AGENTS, type SkillView } from '@kermanych/core';
import type { AgentSkill } from '@kermanych/cloud';
import { assignmentRows } from '../src/lib/settings';

const A = (skillName: string, position = 0): AgentSkill =>
  ({ projectId: 'p1', agentId: 'review', skillName, position });
const V = (name: string, over: Partial<SkillView> = {}): SkillView =>
  ({ name, description: 'd', source: 'project', ...over });

test('only instruction-bearing agents can be assigned to', () => {
  const rows = assignmentRows(AGENTS, [], [], {});
  expect(rows.map((r) => r.agent.id)).toEqual(['review', 'promote', 'pull-request', 'resolve-conflict']);
});

test('assigned skills come back in position then name order', () => {
  const rows = assignmentRows(AGENTS, [A('b', 1), A('a', 1), A('zero', 0)],
    [V('a'), V('b'), V('zero')], { a: 10, b: 10, zero: 10 });
  expect(rows[0]!.skills.map((s) => s.name)).toEqual(['zero', 'a', 'b']);
});

test('a name the resolved view does not contain is marked broken, not dropped', () => {
  const rows = assignmentRows(AGENTS, [A('gone')], [], {});
  expect(rows[0]!.skills).toEqual([{ name: 'gone', broken: true }]);
});

test('a repo-shadowed skill carries its path, and the byte total sums the bodies', () => {
  const rows = assignmentRows(AGENTS, [A('x'), A('y')],
    [V('x', { shadowedByRepo: '/repo/.omp/skills/x/SKILL.md' }), V('y', { source: 'default' })],
    { x: 1200, y: 800 });
  expect(rows[0]!.skills[0]).toMatchObject({ name: 'x', shadowedByRepo: '/repo/.omp/skills/x/SKILL.md' });
  expect(rows[0]!.skills[1]).toMatchObject({ name: 'y', source: 'default' });
  expect(rows[0]!.bytes).toBe(2000);
});
```

- [ ] **Step 2: Run it, see it fail, then implement the merge**

```ts
// in apps/ui/src/lib/settings.ts
/** One row of the assignment board: an agent, what it was given, and what that costs. */
export interface AssignmentRow {
  agent: AgentDef;
  skills: { name: string; source?: SkillView['source']; shadowedByRepo?: string; broken?: boolean }[];
  bytes: number;
}

/**
 * The board is a pure merge of three reads: the registry, the project's assignments and the
 * RESOLVED library view. A name the view does not carry is `broken` rather than absent —
 * a deleted skill must be visible as a dangling assignment, not vanish with its agent's row.
 */
export function assignmentRows(
  agents: readonly AgentDef[],
  assignments: readonly AgentSkill[],
  view: readonly SkillView[],
  bodyBytes: Readonly<Record<string, number>>,
): AssignmentRow[] {
  const byName = new Map(view.map((v) => [v.name, v]));
  return agents
    .filter((a) => a.instruction)
    .map((agent) => {
      const mine = assignments
        .filter((r) => r.agentId === agent.id)
        .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
      const skills = mine.map((r) => {
        const hit = byName.get(r.skillName);
        if (!hit) return { name: r.skillName, broken: true };
        return {
          name: hit.name,
          source: hit.source,
          ...(hit.shadowedByRepo ? { shadowedByRepo: hit.shadowedByRepo } : {}),
        };
      });
      const bytes = mine.reduce((sum, r) => sum + (bodyBytes[r.skillName] ?? 0), 0);
      return { agent, skills, bytes };
    });
}
```

- [ ] **Step 3: Write the panel.** Per agent row from `assignmentRows`: the label, its assigned skills with source badges (`дефолт` / `проєкт` / `перекрито репо`) and a broken-reference row for a dangling name, add/remove controls, and the byte total with a warning past a threshold. `bodyBytes` comes from the project's cloud rows (`listProjectSkills`) plus `DEFAULT_SKILLS` for names with no row. Writes go straight to Supabase (`setAgentSkill` / `deleteAgentSkill`) and the panel reloads after each; owner-only, disabled otherwise, exactly as the library panel does it. A failed load shows the error line and never a list. Add the `project-agents` pane to `SettingsPage.vue` in the same shape Task 6 used for the library.

- [ ] **Step 4: The explainer.** Four sentences, verbatim from spec §3.7, above the list:

```
1. Скіл у бібліотеці — агент бере його сам, коли вважає за потрібне; у чаті це видно окремим рядком `skill`.
2. Скіл, призначений ролі, вклеюється в інструкцію запуску — агент не може його не побачити.
3. Той самий скіл може бути і в бібліотеці, і призначеним: у блоці призначення він наведений повністю, і агенту сказано не читати його вдруге з бібліотеки.
4. Призначений текст оплачується контекстом на кожному ході — тримай його коротким.
```

The library panel gains one line pointing here.

- [ ] **Step 5: Verify** (`vitest run test/assignments.spec.ts`, `typecheck`) **and commit**

```bash
git commit -m "feat(ui): assign skills to Kermanych's agents"
```

---

### Task 9: The trigger list

**Files:**
- Create: `kermanych/apps/ui/src/components/settings/TriggersPanel.vue`
- Modify: `kermanych/apps/ui/src/pages/SettingsPage.vue` (add the `project-triggers` pane), `kermanych/apps/ui/src/lib/settings.ts`
- Test: `kermanych/apps/ui/test/triggers-view.spec.ts`

**Interfaces:**
- Consumes: `listTriggers`, `upsertTrigger`, `deleteTrigger`, `type ProjectTrigger` from `@kermanych/cloud`; `AGENTS` from `@kermanych/core`.
- Produces: `triggerActionOptions(source: TriggerSource)` and `triggerMatches(pattern: string, sample: string): boolean | string` in `apps/ui/src/lib/settings.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// kermanych/apps/ui/test/triggers-view.spec.ts
import { expect, test } from 'vitest';
import { triggerActionOptions, triggerMatches } from '../src/lib/settings';

test('only an operator-sourced trigger may run an agent', () => {
  expect(triggerActionOptions('operator').map((o) => o.value)).toEqual(['skill', 'agent']);
  for (const s of ['assistant', 'thinking', 'tool'] as const) {
    expect(triggerActionOptions(s).map((o) => o.value)).toEqual(['skill']);
  }
});

test('the test field reports a match, a miss, and a broken pattern distinguishably', () => {
  expect(triggerMatches('new env var', 'we need a new env var here')).toBe(true);
  expect(triggerMatches('new env var', 'nothing relevant')).toBe(false);
  expect(typeof triggerMatches('env(', 'anything')).toBe('string');
});
```

- [ ] **Step 2: Run them, see them fail, then implement both helpers**

```ts
// in apps/ui/src/lib/settings.ts
/**
 * Which actions a source can carry. A child cannot call back into Kermanych, so only a
 * trigger matched on the OPERATOR's message can run an agent; the DB carries the same rule as
 * a check constraint, and this is what stops the editor from offering an unsavable choice.
 */
export function triggerActionOptions(source: TriggerSource): { value: 'skill' | 'agent'; label: string }[] {
  const skill = { value: 'skill' as const, label: 'вкинути скіл' };
  return source === 'operator' ? [skill, { value: 'agent', label: 'запустити агента' }] : [skill];
}

/**
 * The editor's test field: does this pattern match this sample? A pattern that does not
 * compile returns its error MESSAGE, so a broken regex is visible while typing rather than at
 * launch, where it would be logged as a warning and the trigger would silently never fire.
 */
export function triggerMatches(pattern: string, sample: string): boolean | string {
  try {
    return new RegExp(pattern).test(sample);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
```

- [ ] **Step 3: Write the panel.** A list of triggers (label, source, pattern, action → target, mode, enabled) and an editor with: `id` (immutable after creation), label, source, pattern plus **the test field** (paste a sample, see match/miss/bad-pattern before saving), path globs for `tool`, action constrained by `triggerActionOptions`, target (a skill from the resolved view or an agent from `AGENTS`, per action), mode defaulting to `remind`, repeat defaulting to `once`. Owner-only writes; a failed load shows the error line.

- [ ] **Step 4: The warnings the probe earned.** Beside the mode selector: choosing `interrupt` aborts the turn and discards the partial answer, and it still does not guarantee obedience — the probe's model re-emitted the forbidden token after being interrupted. Beside the pattern field: a short pattern matches more than it looks (`env` matches `.env`, `environment`, `Convention`), and every match costs a turn. Beside the target: a vague body makes the model investigate instead of act, so the target's text must be an actionable instruction.

- [ ] **Step 5: Verify and commit**

Run: `cd kermanych && pnpm --filter @kermanych/ui exec vitest run test/triggers-view.spec.ts && pnpm --filter @kermanych/ui typecheck`

```bash
git commit -m "feat(ui): the trigger list"
```

---

## Final verification

- [ ] `cd kermanych && pnpm -r test` — every package suite green; the RLS suite skipped.
- [ ] `cd kermanych && KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts` — including the new trigger case.
- [ ] `cd kermanych && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/ui typecheck` — clean.
- [ ] `cd /path/to/main/clone/kermanych && supabase migration list --linked && supabase db push --linked --dry-run` — shows exactly `20260828090000_ai_team` pending, then apply it. **Merging the branch does not touch the hosted database**; without the push, every read of the two new tables fails and the panels show their error line.
- [ ] Manual smoke (`pnpm dev:app`): Налаштування → Застосунок → ШІ команда lists six agents, four with English templates and two with none; Проєкт → ШІ команда assigns a skill to Ревізор and a review shows that text in its opening message; Проєкт → Тригери creates a `thinking` trigger whose test field matches a pasted sample, and a session that reasons about the pattern receives the injection; Проєкт → Бібліотека скілів is the former Менеджмент screen, and Менеджмент no longer lists it.
