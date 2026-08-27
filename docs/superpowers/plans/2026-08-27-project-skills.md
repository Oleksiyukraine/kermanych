# Project Skill Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Kermanych project a library of skills — Kermanych's own defaults plus per-project ones authored in the UI — delivered to each `omp` session so the model discovers them natively, never shadowing the repository's own skills, with the selection visible in the chat.

**Architecture:** Skill rows live in a new Supabase table `project_skills`. Before each `omp` spawn, the API resolves `DEFAULT_SKILLS` ← project rows, drops any name the target repository already defines, writes `~/.kermanych/skills/<projectId>/<name>/SKILL.md`, and passes `--config <overlay>.yml` whose `skills.customDirectories` points at that directory. A skill is used by reading `skill://<name>`, so the transcript renames that `read` row to `skill` and labels it with the source.

**Tech Stack:** TypeScript, NestJS (api), Quasar/Vue 3 (ui), Supabase/Postgres + RLS (cloud), vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-27-project-skills-design.md`

## Global Constraints

- **The repository always wins.** A library skill whose name matches a skill directory in the session cwd is not materialized. Verified failure mode: with a name collision, `omp` silently serves the overlay copy and the repo skill disappears.
- **`description` is mandatory and non-blank.** `omp` scans custom directories with `requireDescription: true` and silently drops a skill without one.
- **Skill names are directory names.** Allowed shape, everywhere (DB check, core validator, service re-check): `/^[a-z0-9][a-z0-9-]{0,63}$/`.
- **Custom-directory scanning is non-recursive:** exactly `<dir>/<name>/SKILL.md`.
- **Skills are launch-time only.** No RPC command changes skills, tools or the system prompt after start; anything skill-related must be decided before `spawn`.
- **Project-level cloud config is owner-only** (`projects_update_owner` precedent); members read.
- **`packages/cloud/src/index.ts` and `packages/core/src/index.ts` enumerate exports.** A new symbol missing from the barrel resolves to `undefined` in the bundled UI.
- **Never block a launch on the library.** Any failure in resolution/materialization degrades to "no `--config`", never to a failed session.
- **UI copy is Ukrainian; code, identifiers and skill bodies are English.**

---

### Task 1: Core skill primitives and Kermanych's default library

**Files:**
- Create: `kermanych/packages/core/src/skills.ts`
- Modify: `kermanych/packages/core/src/index.ts:39` (add an export block after the `platform` line)
- Test: `kermanych/packages/core/test/skills.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SkillDef = { name: string; description: string; body: string }`;
  `type SkillView = { name: string; description: string; source: "default" | "project"; shadowedByRepo?: string }`;
  `const SKILL_NAME_RE: RegExp`; `isSkillName(v: string): boolean`;
  `renderSkillFile(s: SkillDef): string`; `const DEFAULT_SKILLS: readonly SkillDef[]`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/packages/core/test/skills.spec.ts
import { expect, test } from "vitest";
import { DEFAULT_SKILLS, isSkillName, renderSkillFile, SKILL_NAME_RE } from "../src/skills";

test("skill names are safe directory names", () => {
  for (const ok of ["kermanych-session", "a", "a1-b2"]) expect(isSkillName(ok)).toBe(true);
  for (const bad of ["", "-lead", "UPPER", "with space", "a/b", "../evil", "a".repeat(65), "dot.name"])
    expect(isSkillName(bad)).toBe(false);
  // The service re-checks with the same source of truth, so it must be exported.
  expect(SKILL_NAME_RE.test("kermanych-pull-request")).toBe(true);
});

test("renderSkillFile emits the two frontmatter keys omp requires", () => {
  const out = renderSkillFile({ name: "x-y", description: 'a: colon, "quote"', body: "line one\n\n" });
  expect(out).toBe('---\nname: x-y\ndescription: "a: colon, \\"quote\\""\n---\n\nline one\n');
});

test("every shipped default is discoverable by omp", () => {
  expect(DEFAULT_SKILLS.length).toBeGreaterThan(0);
  const names = DEFAULT_SKILLS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  for (const s of DEFAULT_SKILLS) {
    expect(isSkillName(s.name)).toBe(true);
    expect(s.description.trim()).not.toBe("");
    expect(s.body.trim()).not.toBe("");
    // A skill that applies itself without being read would be invisible in the chat.
    expect(s.body).not.toMatch(/alwaysApply|globs:/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/skills"`.

- [ ] **Step 3: Write the implementation**

```ts
// kermanych/packages/core/src/skills.ts
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
```

- [ ] **Step 4: Export from the barrel**

In `kermanych/packages/core/src/index.ts`, after the `export { PLATFORMS, type Platform } from "./platform";` line, add:

```ts
export {
  DEFAULT_SKILLS,
  SKILL_NAME_RE,
  isSkillName,
  renderSkillFile,
  type SkillDef,
  type SkillView,
} from "./skills";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add kermanych/packages/core/src/skills.ts kermanych/packages/core/src/index.ts kermanych/packages/core/test/skills.spec.ts
git commit -m "feat(core): skill library primitives and Kermanych defaults"
```

---

### Task 2: `skill` tool display in core

**Files:**
- Modify: `kermanych/packages/core/src/tool-display.ts:245-254` (add `skillDisplay`, register it in `REDUCERS`)
- Test: `kermanych/packages/core/test/tool-display.spec.ts` (append)

**Interfaces:**
- Consumes: `toolDisplay(tool, args, details, content)` from Task 0 state of the file (already exists).
- Produces: `toolDisplay("skill", { path: "skill://x" }, …).target === "x"`; a `skill` row carries no `stat` of its own, so a caller-supplied stat survives `applyToolResult`.

- [ ] **Step 1: Write the failing test**

```ts
// append to kermanych/packages/core/test/tool-display.spec.ts
test("skill rows keep the full skill name and never mangle the scheme", () => {
  const d = toolDisplay("skill", { path: "skill://kermanych-pull-request" }, {}, "# body\nline\n");
  expect(d.target).toBe("kermanych-pull-request");
  expect(d.lines.map((l) => l.text)).toEqual(["# body", "line"]);
  // No stat of its own: the transcript puts the SOURCE badge in `stat`, and
  // applyToolResult only overwrites it when the reducer names one.
  expect(d.stat).toBeUndefined();
});

test("a skill sub-resource read keeps the sub-path on the target", () => {
  expect(toolDisplay("skill", { path: "skill://pdf/references/tables.md" }, {}, "").target).toBe(
    "pdf/references/tables.md",
  );
});

test("read still shortens ordinary paths (guard against reusing the skill reducer)", () => {
  expect(toolDisplay("read", { path: "/a/b/c/d.ts" }, {}, "").target).toBe("c/d.ts");
});

test("skill rows are never coalesced with file reads", () => {
  expect((COALESCE_TOOLS as readonly string[]).includes("skill")).toBe(false);
});
```

Add `COALESCE_TOOLS` to the file's existing import from `../src/chat-blocks` (or add the import if the file has none).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/tool-display.spec.ts`
Expected: FAIL — the first test reports `target` as `/kermanych-pull-request` (the generic reducer plus `shortPath`).

- [ ] **Step 3: Write the implementation**

In `kermanych/packages/core/src/tool-display.ts`, immediately before `const genericDisplay: Reducer = …`:

```ts
// `skill://<name>[/<sub-path>]` — the name IS the row's identity, so it is never put through
// shortPath: that keeps the last two segments and would render a skill read as a file read
// of `/<name>`, losing the scheme. No `stat` is produced here on purpose; the transcript
// fills it with the source badge (бібліотека / проєкт / репо).
const skillDisplay: Reducer = (args, _d, content) => {
  const target = str(args["path"]).replace(/^skill:\/\//, "");
  const lines = textLines(content);
  return { ...(target ? { target } : {}), lines, totalLines: lines.length };
};
```

Then add `skill: skillDisplay,` to the `REDUCERS` map.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/tool-display.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add kermanych/packages/core/src/tool-display.ts kermanych/packages/core/test/tool-display.spec.ts
git commit -m "feat(core): render skill:// reads as their own tool row"
```

---

### Task 3: Rename skill reads in both transcript paths, with a source label

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/transcript-reducer.ts:35-44` (`ReduceOpts`), `:57-67` (`pendingToolEntry`), `:161-163` (FIFO fallback)
- Modify: `kermanych/apps/api/src/supervisor/messages-to-transcript.ts:39` (signature), `:77`, `:91` (pass-through)
- Test: `kermanych/apps/api/test/skill-rows.spec.ts`

**Interfaces:**
- Consumes: `toolDisplay` with the `skill` reducer (Task 2).
- Produces:
  `type SkillLabel = { stat?: string; intent?: string }`;
  `type SkillSource = (name: string) => SkillLabel | undefined`;
  `skillNameFromArgs(args: Record<string, unknown> | undefined): string | undefined`;
  `pendingToolEntry(id, at, tool, args, intent?, skillSource?: SkillSource)`;
  `ReduceOpts.skillSource?: SkillSource`;
  `messagesToTranscript(messages: unknown[], opts?: { skillSource?: SkillSource })`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/api/test/skill-rows.spec.ts
import { expect, test } from "vitest";
import { reduceRpcEvents } from "../src/supervisor/transcript-reducer";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { RpcEvent } from "@kermanych/core";

const skillSource = (name: string) =>
  name === "kermanych-session"
    ? { stat: "бібліотека", intent: "/Users/u/.kermanych/skills/p1/kermanych-session/SKILL.md" }
    : undefined;

const events = (path: string): RpcEvent[] =>
  [
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path } },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: { content: [{ type: "text", text: "# body" }] },
    },
  ] as unknown as RpcEvent[];

test("a skill read becomes a skill row carrying name and source", () => {
  const { entries } = reduceRpcEvents(events("skill://kermanych-session"), { skillSource });
  const row = entries.find((e) => e.kind === "tool");
  expect(row).toMatchObject({
    kind: "tool",
    tool: "skill",
    target: "kermanych-session",
    stat: "бібліотека",
    intent: "/Users/u/.kermanych/skills/p1/kermanych-session/SKILL.md",
    status: "ok",
  });
});

test("an ordinary file read is untouched", () => {
  const { entries } = reduceRpcEvents(events("/repo/src/main.ts"), { skillSource });
  expect(entries.find((e) => e.kind === "tool")).toMatchObject({ tool: "read", target: "src/main.ts" });
});

test("the end frame still pairs with its start row when omp sends no call id", () => {
  const evs = [
    { type: "tool_execution_start", toolName: "read", args: { path: "skill://kermanych-session" } },
    { type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "x" }] } },
  ] as unknown as RpcEvent[];
  const rows = reduceRpcEvents(evs, { skillSource }).entries.filter((e) => e.kind === "tool");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tool: "skill", status: "ok" });
});

test("rehydrated history renders the same skill row", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "skill://kermanych-session" } }],
    },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "# body" }] },
  ];
  const { entries } = messagesToTranscript(messages, { skillSource });
  expect(entries.find((e) => e.kind === "tool")).toMatchObject({
    tool: "skill",
    target: "kermanych-session",
    stat: "бібліотека",
  });
});

test("an unknown skill name yields a row without a badge rather than throwing", () => {
  const { entries } = reduceRpcEvents(events("skill://not-in-library"), { skillSource });
  const row = entries.find((e) => e.kind === "tool");
  expect(row).toMatchObject({ tool: "skill", target: "not-in-library" });
  expect((row as { stat?: string }).stat).toBeUndefined();
});
```

The fourth test drives the same function `supervisor.rehydrate` uses; `kermanych/apps/api/test/messages-to-transcript.spec.ts` holds further real history shapes if you need another case.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skill-rows.spec.ts`
Expected: FAIL — rows come back as `tool: "read"`, and `messagesToTranscript` rejects a second argument.

- [ ] **Step 3: Implement in `transcript-reducer.ts`**

Add above `pendingToolEntry`:

```ts
// The source badge for a skill row: `stat` shows collapsed (KToolRow renders tool/target/stat
// on the closed row), `intent` only when the row is expanded, so the badge belongs in `stat`
// and the file path in `intent`.
export type SkillLabel = { stat?: string; intent?: string };
export type SkillSource = (name: string) => SkillLabel | undefined;

// omp has no dedicated tool for skills: a skill is used by reading `skill://<name>`. The
// transcript renames that row so it reads as a skill and never coalesces with file reads
// (COALESCE_TOOLS covers `read`). Returns undefined for anything that is not a skill read.
export function skillNameFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  const p = args?.["path"];
  if (typeof p !== "string" || !p.startsWith("skill://")) return undefined;
  const name = p.slice("skill://".length);
  return name || undefined;
}
```

Replace `pendingToolEntry` with:

```ts
export function pendingToolEntry(
  id: string,
  at: number,
  tool: string,
  args: Record<string, unknown> | undefined,
  intent?: string,
  skillSource?: SkillSource,
): ToolEntry {
  // The rename lives HERE, not at the call sites, because both the live stream and the
  // rehydration path build rows through this function: parity depends on one rule.
  const skill = tool === "read" ? skillNameFromArgs(args) : undefined;
  const effective = skill ? "skill" : tool;
  const label = skill ? skillSource?.(skill) : undefined;
  // No recorded arguments means there is nothing to derive a target from. Asking the
  // display reducers with an empty object would invent one — grep answers "//" — and that
  // would later clobber the good target on a row whose start frame we did see.
  const target = args ? toolDisplay(effective, args, undefined, "").target : undefined;
  return {
    kind: "tool", id, at, tool: effective, status: "pending",
    ...(label?.intent ?? intent === undefined ? {} : { intent: label?.intent ?? intent }),
    ...(label?.stat ? { stat: label.stat } : {}),
    ...(target ? { target } : {}),
  };
}
```

Fix the conditional spread so an intent is emitted when either source has one:

```ts
    ...((label?.intent ?? intent) === undefined ? {} : { intent: (label?.intent ?? intent) as string }),
```

Extend `ReduceOpts` with:

```ts
  // Resolves a skill name to its source badge. Injected by the supervisor from the
  // materialised library, so this module stays pure.
  skillSource?: SkillSource;
```

At the `tool_execution_start` branch, pass it through:

```ts
      entries.push(pendingToolEntry(id, at, ev.toolName ?? "?", ev.args, ev.intent, opts?.skillSource));
```

In the `tool_execution_end` branch, widen the FIFO fallback so a renamed row is still found
when omp sends no `toolCallId`:

```ts
      const found =
        (ev.toolCallId ? entries.find((x) => x.kind === "tool" && x.id === ev.toolCallId) : undefined) ??
        entries.find(
          (x) =>
            x.kind === "tool" &&
            x.status === "pending" &&
            // `read` on the wire may have been renamed to `skill` on the row.
            (x.tool === tool || (tool === "read" && x.tool === "skill")),
        );
```

- [ ] **Step 4: Implement the pass-through in `messages-to-transcript.ts`**

```ts
export function messagesToTranscript(messages: unknown[], opts?: { skillSource?: SkillSource }): Rehydrated {
```

Import `type SkillSource` from `./transcript-reducer`, pass `opts?.skillSource` as the sixth
argument of the `pendingToolEntry` call that maps a `toolCall` part, and apply the same
widened FIFO clause where an unmatched result falls back to the oldest pending row of the
same tool name.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skill-rows.spec.ts test/transcript-parity.spec.ts test/messages-to-transcript.spec.ts test/supervisor.transcript.spec.ts`
Expected: PASS — including the pre-existing parity suites, which must stay green.

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/api/src/supervisor/transcript-reducer.ts kermanych/apps/api/src/supervisor/messages-to-transcript.ts kermanych/apps/api/test/skill-rows.spec.ts
git commit -m "feat(api): surface skill:// reads as labelled skill rows"
```

---

### Task 4: Cloud table and typed surface for project skills

**Files:**
- Create: `kermanych/supabase/migrations/20260827090000_project_skills.sql`
- Create: `kermanych/packages/cloud/src/skills.ts`
- Modify: `kermanych/packages/cloud/src/types.ts` (append the three types)
- Modify: `kermanych/packages/cloud/src/index.ts` (barrel)
- Test: `kermanych/packages/cloud/test/skills.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  `type ProjectSkill = { projectId: string; name: string; description: string; body: string; enabled: boolean; updatedAt: string; updatedBy?: string }`;
  `type ProjectSkillInsert = { projectId: string; name: string; description: string; body: string; enabled?: boolean }`;
  `toProjectSkill(row): ProjectSkill`; `listProjectSkills(client, projectIds): Promise<ProjectSkill[]>`;
  `upsertProjectSkill(client, input): Promise<ProjectSkill>`;
  `deleteProjectSkill(client, projectId, name): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/packages/cloud/test/skills.spec.ts
import { expect, test } from "vitest";
import { toProjectSkill } from "../src/skills";

test("maps a row to camelCase and omits a null author", () => {
  expect(
    toProjectSkill({
      project_id: "p1",
      name: "opening-a-pr",
      description: "d",
      body: "b",
      enabled: true,
      updated_at: "2026-08-27T10:00:00Z",
      updated_by: null,
    }),
  ).toEqual({
    projectId: "p1",
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updatedAt: "2026-08-27T10:00:00Z",
  });
});

test("keeps a present author", () => {
  const s = toProjectSkill({
    project_id: "p1", name: "x", description: "d", body: "b", enabled: false,
    updated_at: "2026-08-27T10:00:00Z", updated_by: "u1",
  });
  expect(s.updatedBy).toBe("u1");
  expect(s.enabled).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/cloud exec vitest run test/skills.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/skills"`.

- [ ] **Step 3: Write the migration**

```sql
-- kermanych/supabase/migrations/20260827090000_project_skills.sql
-- Per-project skill library. One ROW per skill, not a JSON blob on `projects`: bodies are
-- prose several members edit repeatedly, and a blob write would clobber a concurrent edit.
-- Deliberately NOT added to supabase_realtime: skills are read when a session launches.
create table public.project_skills (
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- Also a directory name under ~/.kermanych/skills/<projectId>/, hence the strict pattern.
  name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- omp drops a custom-directory skill that has no description, so an empty one is invalid.
  description text not null check (length(btrim(description)) > 0),
  body        text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  primary key (project_id, name)
);

alter table public.project_skills enable row level security;
revoke all on public.project_skills from anon;
grant select, insert, update, delete on public.project_skills to authenticated;

-- Read: any member of the project. Write: the owner only, mirroring projects_update_owner.
create policy project_skills_select_member on public.project_skills for select
  using (exists (select 1 from public.projects p
                 where p.id = project_id
                   and (p.owner_id = auth.uid() or public.is_project_member(p.id, auth.uid()))));

create policy project_skills_insert_owner on public.project_skills for insert
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_update_owner on public.project_skills for update
  using      (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_delete_owner on public.project_skills for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_id and p.owner_id = auth.uid()));

-- Server-owned audit columns, following tasks_guard(): a client cannot backdate an edit.
create or replace function public.project_skills_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_skills_touch
  before insert or update on public.project_skills
  for each row execute function public.project_skills_touch();
```

- [ ] **Step 4: Write the typed surface**

Append to `kermanych/packages/cloud/src/types.ts`:

```ts
// A per-project skill (the Kermanych UI's library). `enabled: false` on a row whose name
// matches one of Kermanych's DEFAULT_SKILLS is how a project turns that default off.
export type ProjectSkill = {
  projectId: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
};

export type ProjectSkillInsert = {
  projectId: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
};
```

Create `kermanych/packages/cloud/src/skills.ts`:

```ts
// Data access for the per-project skill library. Owns the snake_case <-> camelCase boundary
// for `project_skills`. Every call runs under the caller's JWT: the RLS policies (read =
// member, write = owner) are the authorization surface, and refusals surface as thrown
// postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectSkill, ProjectSkillInsert } from "./types";

const SKILL_COLUMNS = "project_id, name, description, body, enabled, updated_at, updated_by";

type SkillRow = {
  project_id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  updated_at: string;
  // `on delete set null`: a skill outlives the account that last edited it.
  updated_by: string | null;
};

export function toProjectSkill(row: SkillRow): ProjectSkill {
  const s: ProjectSkill = {
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
  if (row.updated_by !== null) s.updatedBy = row.updated_by;
  return s;
}

export async function listProjectSkills(client: SupabaseClient, projectIds: string[]): Promise<ProjectSkill[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and a member of no project
  // has no library to read.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("project_skills")
    .select(SKILL_COLUMNS)
    .in("project_id", projectIds)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as SkillRow[]).map(toProjectSkill);
}

// Upsert on the composite key: the editor saves a new skill and an edited one the same way.
export async function upsertProjectSkill(client: SupabaseClient, input: ProjectSkillInsert): Promise<ProjectSkill> {
  const { data, error } = await client
    .from("project_skills")
    .upsert(
      {
        project_id: input.projectId,
        name: input.name,
        description: input.description.trim(),
        body: input.body,
        enabled: input.enabled ?? true,
      },
      { onConflict: "project_id,name" },
    )
    .select(SKILL_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectSkill(data as SkillRow);
}

export async function deleteProjectSkill(client: SupabaseClient, projectId: string, name: string): Promise<void> {
  const { error } = await client.from("project_skills").delete().eq("project_id", projectId).eq("name", name);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 5: Export from the barrel**

In `kermanych/packages/cloud/src/index.ts`, add to the type exports
`ProjectSkill` and `ProjectSkillInsert`, and add the value exports:

```ts
export {
  toProjectSkill,
  listProjectSkills,
  upsertProjectSkill,
  deleteProjectSkill,
} from "./skills";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/cloud exec vitest run test/skills.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Add the RLS integration cases**

Append to `kermanych/packages/cloud/test/rls.spec.ts`, following that file's existing
helpers for minting an owner, a member and an outsider (it is skipped unless
`SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` / `SUPABASE_TEST_SERVICE_KEY` are set):

- the owner can insert a skill for their project;
- a member can `listProjectSkills` and sees it;
- a member's `upsertProjectSkill` is refused;
- an outsider sees zero rows;
- `updated_by` equals the writer's user id after the owner's insert (the trigger runs).

Run: `cd kermanych && pnpm --filter @kermanych/cloud exec vitest run test/rls.spec.ts`
Expected: PASS when the local stack is running and `supabase db reset` has applied the new
migration; SKIPPED otherwise.

- [ ] **Step 8: Commit**

```bash
git add kermanych/supabase/migrations/20260827090000_project_skills.sql kermanych/packages/cloud/src/skills.ts kermanych/packages/cloud/src/types.ts kermanych/packages/cloud/src/index.ts kermanych/packages/cloud/test/skills.spec.ts kermanych/packages/cloud/test/rls.spec.ts
git commit -m "feat(cloud): project_skills table and typed surface"
```

---

### Task 5: SkillsService — resolution, repo shadow guard, materialization

**Files:**
- Create: `kermanych/apps/api/src/skills/skills.service.ts`
- Modify: `kermanych/apps/api/src/app.module.ts:22-34` (register the provider)
- Test: `kermanych/apps/api/test/skills.materialize.spec.ts`

**Interfaces:**
- Consumes: `DEFAULT_SKILLS`, `isSkillName`, `renderSkillFile`, `SkillDef`, `SkillView` (Task 1); `listProjectSkills`, `ProjectSkill` (Task 4); `AuthService.cloudClient()`.
- Produces:
  `const REPO_SKILL_DIRS: readonly string[]`; `skillsRoot(): string`;
  `resolveSkills(rows: readonly ProjectSkill[]): { def: SkillDef; source: "default" | "project" }[]`;
  `repoSkillNames(cwd: string): Promise<Map<string, string>>`;
  `class SkillsService { view(projectId, cwd): Promise<SkillView[]>; materialize(projectId, cwd): Promise<{ configPath: string; view: SkillView[] }> }`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/api/test/skills.materialize.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS } from "@kermanych/core";
import type { ProjectSkill } from "@kermanych/cloud";
import { REPO_SKILL_DIRS, repoSkillNames, resolveSkills, SkillsService } from "../src/skills/skills.service";

const row = (p: Partial<ProjectSkill> & { name: string }): ProjectSkill => ({
  projectId: "p1", description: "d", body: "b", enabled: true, updatedAt: "t", ...p,
});

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-skill-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-skill-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a project row overrides a same-named default", () => {
  const name = DEFAULT_SKILLS[0]!.name;
  const out = resolveSkills([row({ name, description: "mine", body: "my body" })]);
  const hit = out.find((s) => s.def.name === name)!;
  expect(hit.source).toBe("project");
  expect(hit.def.body).toBe("my body");
});

test("enabled:false removes a default, and a new name is added", () => {
  const name = DEFAULT_SKILLS[0]!.name;
  const out = resolveSkills([row({ name, enabled: false }), row({ name: "extra" })]);
  expect(out.some((s) => s.def.name === name)).toBe(false);
  expect(out.find((s) => s.def.name === "extra")?.source).toBe("project");
});

test("invalid rows never reach the filesystem", () => {
  const out = resolveSkills([row({ name: "ok-one" }), row({ name: "ok-two", description: "   " })]);
  expect(out.map((s) => s.def.name)).toContain("ok-one");
  expect(out.map((s) => s.def.name)).not.toContain("ok-two");
});

test("every repo skill location shadows a library skill of the same name", async () => {
  for (const dir of REPO_SKILL_DIRS) {
    const fresh = mkdtempSync(join(tmpdir(), "kmq-skill-scan-"));
    mkdirSync(join(fresh, dir, "kermanych-session"), { recursive: true });
    writeFileSync(join(fresh, dir, "kermanych-session", "SKILL.md"), "---\nname: kermanych-session\n---\n");
    const found = await repoSkillNames(fresh);
    expect(found.get("kermanych-session")).toBe(join(fresh, dir, "kermanych-session", "SKILL.md"));
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("materialize writes the library, the overlay, and skips a repo-shadowed skill", async () => {
  mkdirSync(join(repo, ".claude/skills/kermanych-session"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/kermanych-session/SKILL.md"), "---\nname: kermanych-session\n---\n");
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  // The stub stands in for the cloud read: no network in unit tests.
  svc.readRows = async () => [row({ name: "extra", description: "e", body: "eb" })];

  const { configPath, view } = await svc.materialize("p1", repo);

  const dir = join(home, "skills", "p1");
  expect(readdirSync(dir).sort()).toEqual(["extra", "kermanych-pull-request"]);
  expect(readFileSync(join(dir, "extra", "SKILL.md"), "utf8")).toContain('description: "e"');
  expect(readFileSync(configPath, "utf8")).toBe(`skills:\n  customDirectories:\n    - ${dir}\n`);
  expect(view.find((v) => v.name === "kermanych-session")?.shadowedByRepo).toBe(
    join(repo, ".claude/skills/kermanych-session/SKILL.md"),
  );
  expect(view.find((v) => v.name === "extra")).toMatchObject({ source: "project" });
});

test("a removed skill is pruned on the next materialize", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [row({ name: "temporary" })];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(true);
  svc.readRows = async () => [];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(false);
});

test("an unreachable cloud keeps the last materialised library", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [row({ name: "cached" })];
  await svc.materialize("p1", repo);
  svc.readRows = async () => {
    throw new Error("offline");
  };
  const { configPath } = await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "cached"))).toBe(true);
  expect(existsSync(configPath)).toBe(true);
});

test("an unbound project (no repo path) scans nothing instead of the api's own cwd", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [];
  const view = await svc.view("p1", "");
  expect(view.every((v) => v.shadowedByRepo === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skills.materialize.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/skills/skills.service"`.

- [ ] **Step 3: Write the implementation**

```ts
// kermanych/apps/api/src/skills/skills.service.ts
// Resolves a project's skill library and lays it out on disk for one omp launch.
// The ONLY component that touches the filesystem or decides precedence:
//   repository skills  >  project_skills rows  >  Kermanych's DEFAULT_SKILLS
// The materialised directory doubles as the offline cache — there is no SQLite mirror.
import { Injectable } from "@nestjs/common";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS, isSkillName, renderSkillFile, type SkillDef, type SkillView } from "@kermanych/core";
import { listProjectSkills, type ProjectSkill } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";

// Every project-level skill directory omp itself discovers in the session cwd. One level
// deep, no ancestor walk: a Kermanych session's cwd is always a repository root (a worktree
// root or the bound repo). A library skill whose name appears here is NOT materialised.
export const REPO_SKILL_DIRS = [
  ".omp/skills",
  ".claude/skills",
  ".agent/skills",
  ".agents/skills",
  ".codex/skills",
  ".github/skills",
] as const;

// KERMANYCH_SKILLS_HOME exists for tests, mirroring KERMANYCH_DB in the registry.
export function skillsRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "skills");
}

export type Resolved = { def: SkillDef; source: "default" | "project" };

export function resolveSkills(rows: readonly ProjectSkill[]): Resolved[] {
  const out = new Map<string, Resolved>();
  for (const d of DEFAULT_SKILLS) out.set(d.name, { def: d, source: "default" });
  for (const r of rows) {
    // A disabled row is how a project turns a default off; on a name with no default it is
    // simply nothing to add.
    if (!r.enabled) {
      out.delete(r.name);
      continue;
    }
    out.set(r.name, { def: { name: r.name, description: r.description, body: r.body }, source: "project" });
  }
  // Last line of defence before mkdir/write: the DB has the same constraints, but a bad row
  // from an older client must never become a directory name or a description-less skill.
  return [...out.values()].filter((s) => isSkillName(s.def.name) && s.def.description.trim() !== "");
}

export async function repoSkillNames(cwd: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!cwd) return found;
  for (const rel of REPO_SKILL_DIRS) {
    const base = join(cwd, rel);
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !found.has(e.name)) found.set(e.name, join(base, e.name, "SKILL.md"));
    }
  }
  return found;
}

@Injectable()
export class SkillsService {
  constructor(private auth: AuthService) {}

  // Seam for tests: the cloud read is the one part a unit test cannot perform.
  readRows = async (projectId: string): Promise<ProjectSkill[]> =>
    listProjectSkills(this.auth.cloudClient(), [projectId]);

  // Read-only: what the UI lists. Never writes, so a settings screen cannot mutate a
  // session's library as a side effect of being opened.
  async view(projectId: string, cwd: string): Promise<SkillView[]> {
    const rows = await this.readRows(projectId).catch(() => [] as ProjectSkill[]);
    const repo = await repoSkillNames(cwd);
    return resolveSkills(rows).map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));
  }

  async materialize(projectId: string, cwd: string): Promise<{ configPath: string; view: SkillView[] }> {
    const dir = join(skillsRoot(), projectId);
    const configPath = join(skillsRoot(), `${projectId}.config.yml`);
    const repo = await repoSkillNames(cwd);
    let rows: ProjectSkill[] | undefined;
    try {
      rows = await this.readRows(projectId);
    } catch {
      // Offline or signed out: the directory the last online launch wrote IS the cache, so
      // the session keeps the library it had. Nothing is rewritten and nothing is pruned.
      rows = undefined;
    }
    const resolved = resolveSkills(rows ?? []);
    const view: SkillView[] = resolved.map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));

    await mkdir(dir, { recursive: true });
    // The overlay is a SIBLING of the scanned directory, never inside it.
    await writeFile(configPath, `skills:\n  customDirectories:\n    - ${dir}\n`, "utf8");
    if (rows === undefined) return { configPath, view };

    const keep = new Set<string>();
    for (const { def } of resolved) {
      if (repo.has(def.name)) continue; // the repository's own skill wins the name
      keep.add(def.name);
      await mkdir(join(dir, def.name), { recursive: true });
      await writeFile(join(dir, def.name, "SKILL.md"), renderSkillFile(def), "utf8");
    }
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !keep.has(e.name)) await rm(join(dir, e.name), { recursive: true, force: true });
    }
    return { configPath, view };
  }
}
```

- [ ] **Step 4: Register the provider**

In `kermanych/apps/api/src/app.module.ts`, import `SkillsService` from `./skills/skills.service`
and add it to the `providers` array next to `AuthService`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skills.materialize.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/api/src/skills/skills.service.ts kermanych/apps/api/src/app.module.ts kermanych/apps/api/test/skills.materialize.spec.ts
git commit -m "feat(api): materialise the project skill library for a session"
```

---

### Task 6: Pass `--config` to omp and label rows from the materialised view

**Files:**
- Modify: `kermanych/apps/api/src/rpc/rpc-session.ts:38` (options type), `:47-53` (argv)
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` — the five `new RpcSession(` sites (`:419`, `:575`, `:641`, `:705`, `:1295`), the `reduceRpcEvents(` call, and the `messagesToTranscript(` call in `rehydrate`
- Test: `kermanych/apps/api/test/rpc-session.config.spec.ts`, `kermanych/apps/api/test/skills.e2e.spec.ts`

**Interfaces:**
- Consumes: `SkillsService.materialize` (Task 5), `SkillSource` (Task 3).
- Produces: `RpcSessionOpts.configPath?: string`; `SupervisorService.ompSkills(projectId, cwd, sessionId): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/api/test/rpc-session.config.spec.ts
// A fake `omp` that reports the argv it was launched with, so the flag order is asserted
// against the real spawn path rather than a mock.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function argvEchoOmp(out: string): string {
  const p = join(dir, "echo-argv.mjs");
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

test("configPath becomes --config right after --cwd", async () => {
  const out = join(dir, "argv.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), configPath: "/tmp/p1.config.yml" });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml",
  ]);
});

test("no configPath means no --config", async () => {
  const out = join(dir, "argv2.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out) });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--mode", "rpc", "--cwd", dir]);
});
```

The generated script is ESM (`.mjs`), so it imports `node:fs` rather than calling `require`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/rpc-session.config.spec.ts`
Expected: FAIL — `configPath` is not a valid option (typecheck) and no `--config` is emitted.

- [ ] **Step 3: Implement the argv flag**

In `kermanych/apps/api/src/rpc/rpc-session.ts`, add `configPath?: string;` to the options
type, and in `start()` insert immediately after the `--cwd` element:

```ts
    // The project's skill-library overlay (skills.customDirectories). Launch-time only:
    // no RPC command can add skills to a running child.
    if (this.opts.configPath) argv.push("--config", this.opts.configPath);
```

- [ ] **Step 4: Run the argv tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/rpc-session.config.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire the supervisor**

In `kermanych/apps/api/src/supervisor/supervisor.service.ts`:

1. Add the imports and inject the service: `import { join } from "node:path";` (if absent),
   `import { SkillsService, skillsRoot } from "../skills/skills.service";`, and
   `import type { SkillSource } from "./transcript-reducer";`; then add
   `private skills: SkillsService,` to the constructor parameter list.
2. Add the per-session label map and the helper:

```ts
  // name -> the badge a skill row shows. Written at launch from the materialised view,
  // read by the transcript reducers; dropped with the session.
  private skillLabels = new Map<string, Map<string, { stat: string; intent: string }>>();

  // Lay out the project's skill library for one child and remember how to label its rows.
  // Never throws: a library failure must degrade to "no library", never to a failed launch.
  private async ompSkills(projectId: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
      const { configPath, view } = await this.skills.materialize(projectId, cwd);
      const labels = new Map<string, { stat: string; intent: string }>();
      for (const v of view) {
        // A shadowed name means the agent will read the REPOSITORY's file, so the badge
        // says so and points at it.
        if (v.shadowedByRepo) labels.set(v.name, { stat: "репо", intent: v.shadowedByRepo });
        else
          labels.set(v.name, {
            stat: v.source === "default" ? "бібліотека" : "проєкт",
            intent: join(skillsRoot(), projectId, v.name, "SKILL.md"),
          });
      }
      this.skillLabels.set(sessionId, labels);
      return configPath;
    } catch {
      return undefined;
    }
  }

  private skillSource = (sessionId: string): SkillSource => (name) => this.skillLabels.get(sessionId)?.get(name);
```

3. At each of the five `new RpcSession(` sites, compute the overlay first and pass it. For
   the agent launch at `:575` this reads:

```ts
    const cwd = worktree ? wtDir : project.localRepoPath;
    const configPath = await this.ompSkills(project.id, cwd, id);
    const rpc = new RpcSession({ cwd, model, ...(fork ? { fork } : {}), ...(configPath ? { configPath } : {}) });
```

   Apply the same two lines at the chat site (`:419`, cwd = `project.localRepoPath`), the
   discussion site (`:641`), the review site (`:705`) and `doResume` (`:1295`), using each
   site's own cwd and session id.

4. Pass the lookup into both transcript paths: add `skillSource: this.skillSource(id)` to the
   existing options object of the `reduceRpcEvents(` call, and pass
   `{ skillSource: this.skillSource(id) }` as the second argument of `messagesToTranscript(`.

5. Where a session's live state is discarded (`this.map.delete(id)` /
   `this.toolDetails.dropSession(id)`), add `this.skillLabels.delete(id);`.

- [ ] **Step 6: Write the end-to-end test against a real omp**

```ts
// kermanych/apps/api/test/skills.e2e.spec.ts
// Env-gated, like packages/cloud's RLS suite: needs a working `omp` on PATH.
// KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSkill } from "@kermanych/cloud";
import { RpcSession } from "../src/rpc/rpc-session";
import { SkillsService } from "../src/skills/skills.service";

const gated = process.env.KERMANYCH_E2E_OMP === "1";

describe.skipIf(!gated)("skill library reaches a real omp child", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "kmq-e2e-repo-"));
    home = mkdtempSync(join(tmpdir(), "kmq-e2e-home-"));
    process.env.KERMANYCH_SKILLS_HOME = home;
  });
  afterEach(() => {
    delete process.env.KERMANYCH_SKILLS_HOME;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const row = (name: string, description: string): ProjectSkill => ({
    projectId: "p1", name, description, body: "body", enabled: true, updatedAt: "t",
  });

  async function systemPrompt(configPath: string, cwd: string): Promise<string> {
    const rpc = new RpcSession({ cwd, configPath });
    rpc.onExit(() => {});
    await rpc.start();
    try {
      const state = (await rpc.getState()) as { systemPrompt?: string[] };
      return (state.systemPrompt ?? []).join("\n");
    } finally {
      await rpc.stop();
    }
  }

  test("library skills appear in the system prompt", async () => {
    const svc = new SkillsService({ cloudClient: () => ({}) } as never);
    svc.readRows = async () => [row("probe-alpha", "PROBE ALPHA from the library")];
    const { configPath } = await svc.materialize("p1", repo);
    const sp = await systemPrompt(configPath, repo);
    expect(sp).toContain("probe-alpha");
    expect(sp).toContain("PROBE ALPHA from the library");
  }, 120_000);

  test("a repository skill of the same name wins", async () => {
    mkdirSync(join(repo, ".claude/skills/probe-alpha"), { recursive: true });
    writeFileSync(
      join(repo, ".claude/skills/probe-alpha/SKILL.md"),
      "---\nname: probe-alpha\ndescription: PROBE ALPHA from the repository\n---\nrepo body\n",
    );
    const svc = new SkillsService({ cloudClient: () => ({}) } as never);
    svc.readRows = async () => [row("probe-alpha", "PROBE ALPHA from the library")];
    const { configPath } = await svc.materialize("p1", repo);
    const sp = await systemPrompt(configPath, repo);
    expect(sp).toContain("PROBE ALPHA from the repository");
    expect(sp).not.toContain("PROBE ALPHA from the library");
  }, 120_000);
});
```

`RpcSession.getState()` (`rpc-session.ts:137-141`) is the `get_state` wrapper; it returns the
documented payload cast to `RpcStateData`, whose `systemPrompt` is the skill list's home.

- [ ] **Step 7: Run the suites**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run`
Expected: PASS, with `skills.e2e.spec.ts` skipped.

Run: `cd kermanych && KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts`
Expected: PASS (2 tests) with `omp` installed and authenticated.

- [ ] **Step 8: Commit**

```bash
git add kermanych/apps/api/src/rpc/rpc-session.ts kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/rpc-session.config.spec.ts kermanych/apps/api/test/skills.e2e.spec.ts
git commit -m "feat(api): deliver the skill library to every omp session"
```

---

### Task 7: Resolved-view endpoint and the Менеджмент editor

**Files:**
- Create: `kermanych/apps/api/src/http/skills.controller.ts`
- Modify: `kermanych/apps/api/src/app.module.ts:21` (controllers array)
- Modify: `kermanych/apps/ui/src/lib/api.ts` (one helper next to `patchProject`, `:137-140`)
- Modify: `kermanych/apps/ui/src/lib/management.ts:19-26` (one row)
- Modify: `kermanych/apps/ui/src/router/routes.ts:15-17` (`SECTION_PAGES`)
- Create: `kermanych/apps/ui/src/pages/ManagementSkillsPage.vue`
- Test: `kermanych/apps/api/test/skills.endpoint.spec.ts`

**Interfaces:**
- Consumes: `SkillsService.view` (Task 5); `listProjectSkills`, `upsertProjectSkill`, `deleteProjectSkill` (Task 4); `SkillView` (Task 1).
- Produces: `GET /api/projects/:id/skills → SkillView[]`; `api.projectSkills(id): Promise<SkillView[]>`; the route `management-skills` at `/management/skills`.

- [ ] **Step 1: Write the failing test**

```ts
// kermanych/apps/api/test/skills.endpoint.spec.ts
import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { SkillsController } from "../src/http/skills.controller";
import type { SkillsService } from "../src/skills/skills.service";
import type { RegistryService } from "../src/registry/registry.service";

test("returns the resolved view for a bound project", async () => {
  const repo = mkdtempSync(join(tmpdir(), "kmq-skill-ep-"));
  mkdirSync(join(repo, ".omp/skills/mine"), { recursive: true });
  writeFileSync(join(repo, ".omp/skills/mine/SKILL.md"), "---\nname: mine\n---\n");
  const registry = { listProjects: () => [{ id: "p1", localRepoPath: repo }] } as unknown as RegistryService;
  const skills = {
    view: async (id: string, cwd: string) => [{ name: "mine", description: "d", source: "project" as const, shadowedByRepo: join(cwd, ".omp/skills/mine/SKILL.md") }],
  } as unknown as SkillsService;
  const out = await new SkillsController(skills, registry).list("p1");
  expect(out[0]).toMatchObject({ name: "mine", shadowedByRepo: join(repo, ".omp/skills/mine/SKILL.md") });
  rmSync(repo, { recursive: true, force: true });
});

test("an unknown project is a 400, not a crash", async () => {
  const registry = { listProjects: () => [] } as unknown as RegistryService;
  const skills = { view: async () => [] } as unknown as SkillsService;
  await expect(new SkillsController(skills, registry).list("nope")).rejects.toBeInstanceOf(BadRequestException);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skills.endpoint.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/http/skills.controller"`.

- [ ] **Step 3: Write the controller**

```ts
// kermanych/apps/api/src/http/skills.controller.ts
// The RESOLVED view of a project's skill library. Writes go straight from the UI to
// Supabase (RLS is the gate); only this read needs the API, because the repository-shadow
// check is a filesystem question about this machine's checkout.
import { BadRequestException, Controller, Get, Param } from "@nestjs/common";
import type { SkillView } from "@kermanych/core";
import { SkillsService } from "../skills/skills.service";
import { RegistryService } from "../registry/registry.service";

@Controller("projects")
export class SkillsController {
  constructor(
    private skills: SkillsService,
    private registry: RegistryService,
  ) {}

  @Get(":id/skills")
  async list(@Param("id") id: string): Promise<SkillView[]> {
    const project = this.registry.listProjects().find((p) => p.id === id);
    if (!project) throw new BadRequestException("project not found");
    // An unbound project has no checkout to scan; the view then reports no shadowing.
    return this.skills.view(id, project.localRepoPath);
  }
}
```

Register `SkillsController` in the `controllers` array of `app.module.ts`.

- [ ] **Step 4: Run the endpoint tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/skills.endpoint.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the UI data access**

In `kermanych/apps/ui/src/lib/api.ts`, add `SkillView` to the `@kermanych/core` type import
and, next to `patchProject`, add:

```ts
  // The resolved library (defaults + project rows, minus anything the repo already defines).
  projectSkills: (id: string): Promise<SkillView[]> => get<SkillView[]>(`/projects/${id}/skills`),
```

In `kermanych/apps/ui/src/lib/management.ts`, add a row after the `management-storage` entry:

```ts
  { name: 'management-skills', path: 'skills', label: 'Skills' },
```

In `kermanych/apps/ui/src/router/routes.ts`, add to `SECTION_PAGES`:

```ts
  'management-skills': () => import('pages/ManagementSkillsPage.vue'),
```

- [ ] **Step 6: Write the section page**

```vue
<!-- kermanych/apps/ui/src/pages/ManagementSkillsPage.vue -->
<template>
  <section class="sk">
    <p class="sk__lead">
      Бібліотека скілів проєкту
      <span class="sk__lead-project mono">{{ projectName }}</span>
      — агент сам вирішує, коли їх узяти. Скіл із таким же імʼям у репозиторії завжди
      перемагає: Керманич його не підміняє.
    </p>

    <p v-if="error" class="sk__error mono">{{ error }}</p>

    <ul v-if="rows.length" class="sk__list">
      <li v-for="row in rows" :key="row.name" class="sk__row">
        <div class="sk__head">
          <span class="sk__name mono">{{ row.name }}</span>
          <span class="sk__badge" :class="`sk__badge--${badgeKind(row)}`">{{ badgeLabel(row) }}</span>
        </div>
        <p class="sk__desc">{{ row.description }}</p>
        <p v-if="row.shadowedByRepo" class="sk__shadow mono">{{ row.shadowedByRepo }}</p>
        <div class="sk__actions">
          <button type="button" class="sk__btn" :disabled="!canWrite" @click="edit(row)">Редагувати</button>
          <button
            v-if="row.source === 'project'"
            type="button"
            class="sk__btn"
            :disabled="!canWrite"
            @click="remove(row.name)"
          >Видалити</button>
          <button v-else type="button" class="sk__btn" :disabled="!canWrite" @click="disable(row.name)">
            Вимкнути
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="sk__empty mono">Бібліотека порожня.</p>

    <button type="button" class="sk__btn sk__btn--primary" :disabled="!canWrite" @click="create">
      Додати скіл
    </button>

    <KModal v-model="editorOpen" :title="editing ? `Скіл · ${draftName}` : 'Новий скіл'">
      <KField
        v-model="draftName"
        label="Імʼя (латиниця, цифри, дефіс)"
        :disabled="editing"
        placeholder="opening-a-pr"
      />
      <KField
        v-model="draftDescription"
        label="Коли застосовувати (обовʼязково)"
        placeholder="Use when … — без опису omp проігнорує скіл"
      />
      <KField v-model="draftBody" label="Текст скіла (Markdown)" multiline />
      <p v-if="formError" class="sk__error mono">{{ formError }}</p>
      <template #controls>
        <button type="button" class="sk__btn" @click="editorOpen = false">Скасувати</button>
        <button type="button" class="sk__btn sk__btn--primary" :disabled="saving" @click="save">Зберегти</button>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The project's skill library. Reads the RESOLVED view from the local API (only it can see
// whether the bound checkout already defines a skill of the same name) and writes rows
// straight to Supabase, where RLS enforces owner-only edits — the same split the .env editor
// uses for values-vs-names.
import { computed, onMounted, ref } from 'vue';
import { SKILL_NAME_RE, type SkillView } from '@kermanych/core';
import { deleteProjectSkill, listProjectSkills, upsertProjectSkill } from '@kermanych/cloud';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useProjects } from '../stores/projects';
import KModal from '../components/kit/KModal.vue';
import KField from '../components/kit/KField.vue';

const props = defineProps<{ projectId: string; projectName: string }>();

const auth = useAuth();
const projects = useProjects();
const rows = ref<SkillView[]>([]);
const error = ref('');
const editorOpen = ref(false);
const editing = ref(false);
const saving = ref(false);
const formError = ref('');
const draftName = ref('');
const draftDescription = ref('');
const draftBody = ref('');

const canWrite = computed(() => projects.isOwner(props.projectId));

function badgeKind(row: SkillView): string {
  return row.shadowedByRepo ? 'repo' : row.source;
}
function badgeLabel(row: SkillView): string {
  if (row.shadowedByRepo) return 'перекрито репо';
  return row.source === 'default' ? 'дефолт' : 'проєкт';
}

async function load(): Promise<void> {
  error.value = '';
  try {
    rows.value = await api.projectSkills(props.projectId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

function create(): void {
  editing.value = false;
  draftName.value = '';
  draftDescription.value = '';
  draftBody.value = '';
  formError.value = '';
  editorOpen.value = true;
}

async function edit(row: SkillView): Promise<void> {
  editing.value = true;
  draftName.value = row.name;
  draftDescription.value = row.description;
  formError.value = '';
  // A default has no row yet: its body comes from the library constant, so the editor opens
  // on the cloud row when one exists and on an empty body when it does not.
  const stored = (await listProjectSkills(auth.client, [props.projectId])).find((s) => s.name === row.name);
  draftBody.value = stored?.body ?? '';
  editorOpen.value = true;
}

async function save(): Promise<void> {
  formError.value = '';
  if (!SKILL_NAME_RE.test(draftName.value)) {
    formError.value = 'Імʼя: лише малі латинські літери, цифри та дефіс (до 64 символів).';
    return;
  }
  if (!draftDescription.value.trim()) {
    formError.value = 'Без опису omp проігнорує скіл.';
    return;
  }
  saving.value = true;
  try {
    await upsertProjectSkill(auth.client, {
      projectId: props.projectId,
      name: draftName.value,
      description: draftDescription.value,
      body: draftBody.value,
    });
    editorOpen.value = false;
    await load();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function remove(name: string): Promise<void> {
  try {
    await deleteProjectSkill(auth.client, props.projectId, name);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// Turning a Kermanych default off is a row with enabled:false — the resolver drops the name.
async function disable(name: string): Promise<void> {
  const def = rows.value.find((r) => r.name === name);
  if (!def) return;
  try {
    await upsertProjectSkill(auth.client, {
      projectId: props.projectId,
      name,
      description: def.description,
      body: '',
      enabled: false,
    });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<style scoped>
.sk__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.sk__lead-project { color: var(--k-text); }
.sk__list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
.sk__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.sk__head { display: flex; align-items: center; gap: 8px; }
.sk__name { font-size: 12.5px; }
.sk__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); }
.sk__badge--repo { color: var(--k-accent); border-color: var(--k-accent); }
.sk__desc { margin: 6px 0 0; font-size: 12.5px; }
.sk__shadow { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); }
.sk__actions { display: flex; gap: 6px; margin-top: 8px; }
.sk__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.sk__btn:disabled { opacity: 0.45; cursor: default; }
.sk__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.sk__error { font-size: 11.5px; color: var(--k-accent); }
.sk__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
</style>
```

`KModal` exposes its footer as the `controls` slot (`KModal.vue:17-19`) — the template above
uses it — and `KField` is used exactly as in `MainLayout.vue:207-214`.

- [ ] **Step 7: Verify the UI typechecks**

Run: `cd kermanych && pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/ui typecheck`
Expected: no type errors (`typecheck` is `vue-tsc --noEmit`, `apps/ui/package.json:11`).

- [ ] **Step 8: Commit**

```bash
git add kermanych/apps/api/src/http/skills.controller.ts kermanych/apps/api/src/app.module.ts kermanych/apps/api/test/skills.endpoint.spec.ts kermanych/apps/ui/src/lib/api.ts kermanych/apps/ui/src/lib/management.ts kermanych/apps/ui/src/router/routes.ts kermanych/apps/ui/src/pages/ManagementSkillsPage.vue
git commit -m "feat(ui): project skill library section"
```

---

### Task 8: Make the choice legible — accented row and a `Скіли` session field

**Files:**
- Modify: `kermanych/packages/core/src/skills.ts` (add `skillsUsed`), `kermanych/packages/core/src/index.ts` (barrel)
- Modify: `kermanych/packages/core/test/skills.spec.ts` (append)
- Modify: `kermanych/apps/ui/src/components/kit/KToolRow.vue:5` (accent the tool cell)
- Modify: `kermanych/apps/ui/src/pages/WorkspacePage.vue:169-172` (a meta row after «Контекст»)

**Interfaces:**
- Consumes: `TranscriptEntry` (core types), the `skill` rows from Task 3.
- Produces: `skillsUsed(entries: readonly TranscriptEntry[]): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// append to kermanych/packages/core/test/skills.spec.ts
import { skillsUsed } from "../src/skills";
import type { TranscriptEntry } from "../src/types";

test("skillsUsed lists unique skills in order of first use", () => {
  const entries = [
    { kind: "tool", id: "1", at: 1, tool: "read", status: "ok", target: "src/a.ts" },
    { kind: "tool", id: "2", at: 2, tool: "skill", status: "ok", target: "kermanych-session" },
    { kind: "tool", id: "3", at: 3, tool: "skill", status: "ok", target: "kermanych-pull-request" },
    { kind: "tool", id: "4", at: 4, tool: "skill", status: "ok", target: "kermanych-session" },
    // A sub-resource read counts as its parent skill, not a second entry.
    { kind: "tool", id: "5", at: 5, tool: "skill", status: "ok", target: "kermanych-session/refs/x.md" },
    { kind: "tool", id: "6", at: 6, tool: "skill", status: "pending" },
  ] as TranscriptEntry[];
  expect(skillsUsed(entries)).toEqual(["kermanych-session", "kermanych-pull-request"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts`
Expected: FAIL — `skillsUsed is not a function`.

- [ ] **Step 3: Implement**

Append to `kermanych/packages/core/src/skills.ts`:

```ts
import type { TranscriptEntry } from "./types";

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
```

Add `skillsUsed` to the `./skills` export block in `kermanych/packages/core/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/skills.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Accent the skill row**

In `kermanych/apps/ui/src/components/kit/KToolRow.vue`, change the tool cell to

```html
      <span class="k-tr__t" :class="{ 'k-tr__t--skill': entry.tool === 'skill' }">{{ entry.tool }}</span>
```

and add to its `<style>` block:

```css
/* A skill row is the agent choosing from the library — worth finding at a glance among
   dozens of file reads. */
.k-tr__t--skill { color: var(--k-accent); }
```

- [ ] **Step 6: Add the `Скіли` session field**

In `kermanych/apps/ui/src/pages/WorkspacePage.vue`, import `skillsUsed` from
`@kermanych/core`, add

```ts
const usedSkills = computed(() => skillsUsed(entries.value));
```

reusing the file's existing `entries` computed (`WorkspacePage.vue:638-642`, which already
resolves the selected session's transcript), and insert after the «Контекст» meta row:

```html
            <div class="ws__meta-row">
              <dt
                class="ws__meta-label"
                title="Скіли, які агент прочитав сам. Скіл, узятий субагентом, тут не видно."
              >Скіли</dt>
              <dd class="ws__meta-value mono">{{ usedSkills.join(', ') || '—' }}</dd>
            </div>
```

- [ ] **Step 7: Verify the build**

Run: `cd kermanych && pnpm --filter @kermanych/core build && pnpm --filter @kermanych/ui build`
Expected: build succeeds.

- [ ] **Step 8: Manual smoke**

```bash
cd kermanych && pnpm dev:app
```

1. Open Менеджмент → Skills for a bound project, add a skill whose description names a task you can trigger (for example: "Use when the user asks for the release checklist").
2. Launch a session in that project with a task that matches the description.
3. Confirm: a row `skill  <name>  бібліотека` appears in the log (collapsed, accented), the «Сесія» tab shows it under `Скіли`, and `git -C ~/.kermanych/worktrees/<id> status --short` is clean (nothing was written into the worktree).
4. Add `.claude/skills/<same-name>/SKILL.md` to the repository, commit it, launch a new session: the Skills list shows «перекрито репо» with the file path, and `~/.kermanych/skills/<projectId>/<same-name>` does not exist.

- [ ] **Step 9: Commit**

```bash
git add kermanych/packages/core/src/skills.ts kermanych/packages/core/src/index.ts kermanych/packages/core/test/skills.spec.ts kermanych/apps/ui/src/components/kit/KToolRow.vue kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): show which skill the agent took"
```

---

## Final verification

- [ ] `cd kermanych && pnpm -r test` — every package suite green (`skills.e2e.spec.ts` skipped).
- [ ] `cd kermanych && KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts` — both real-omp cases pass.
- [ ] `cd kermanych && supabase db push --linked --dry-run` — shows exactly `20260827090000_project_skills` as the pending migration, then apply it with `supabase db push --linked`. The hosted project is NOT updated by merging a branch; an unpushed migration makes the UI call a table that does not exist.
- [ ] Manual smoke of Task 8 Step 8 completed on a bound project.
