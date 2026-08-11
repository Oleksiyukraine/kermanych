# Discussion Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator fork a side "discussion" conversation off a running agent from its chat, explore it in isolation, then merge a reviewed summary back into the parent or discard it.

**Architecture:** A branch is a new Kermanych session in a third mode (`kind: "discussion"`) that touches no git: it forks the parent's omp conversation via `omp --mode rpc --fork <parent.ompSessionFile> --no-tools`, runs in the parent's directory as its own child process, and is rendered as a nested row under its parent on the board. Merge injects a summary into the parent as a message (`sendMessage`); discard tears the child down; deleting a parent cascade-discards its children.

**Tech Stack:** TypeScript, NestJS (`apps/api`), Quasar/Vue 3 + Pinia (`apps/ui`), `better-sqlite3` registry, vitest. Domain types in `packages/core`.

**Spec:** `docs/superpowers/specs/2026-08-10-kermanych-discussion-branch-design.md`

## Global Constraints

- Node 22.x (native `better-sqlite3`). pnpm workspace.
- File content / identifiers / commit messages: English. UI copy: Ukrainian (match existing strings).
- Follow existing patterns: registry migrations are idempotent `ALTER TABLE ... ADD COLUMN` in try/catch; REST handlers wrap `sup.*` in try/catch → `BadRequestException`; UI mutations go through the Pinia store → `api`.
- v1 is **tip-level** branching (fork at the parent's current leaf). No omp entry ids, no `branch_entry_id` column. Entry-level is deferred.
- Discussion children never run git. Any code path keyed on `!s.worktree` that would run git MUST exclude `kind === "discussion"`.
- Run typecheck/tests once at the end of each task, not project-wide between every step.

---

### Task 1: Core `Session` gains `kind` + `parentSessionId`

**Files:**
- Modify: `kermanych/packages/core/src/types.ts:12-21`

**Interfaces:**
- Produces: `Session.kind: "agent" | "discussion"`, `Session.parentSessionId?: string`.

- [ ] **Step 1: Add the two fields to the `Session` type**

In `types.ts`, the `Session` type currently ends:
```ts
  worktree: boolean; baseBranch?: string;
  ompSessionId?: string; ompSessionFile?: string;
```
Add after the `worktree`/`baseBranch` line:
```ts
  kind: "agent" | "discussion";
  parentSessionId?: string;
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @kermanych/core exec tsc --noEmit`
Expected: PASS (no usages break — new field is required but every construction site is updated in Task 2/3).

Note: this will surface type errors at construction sites; those are fixed in Task 2 (registry) and Task 3 (supervisor). If running standalone shows errors only in `apps/api`, that is expected until those tasks land — you may run this step's typecheck at the workspace root after Task 3.

- [ ] **Step 3: Commit**

```bash
git add kermanych/packages/core/src/types.ts
git commit -m "feat(core): add Session.kind and parentSessionId"
```

---

### Task 2: Registry persists `kind` + `parentSessionId`

**Files:**
- Modify: `kermanych/apps/api/src/registry/registry.service.ts` (constructor migration ~line 59; `listSessions` line 94; `createSession` lines 104-138)
- Test: `kermanych/apps/api/test/registry.branch.spec.ts` (create)

**Interfaces:**
- Consumes: `Session.kind`, `Session.parentSessionId` (Task 1).
- Produces: `createSession({ …, kind?, parentSessionId? })` persists them (default `kind: "agent"`); `listSessions()` returns them.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/registry.branch.spec.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

function reg() {
  return new RegistryService(":memory:");
}

describe("registry discussion branches", () => {
  it("defaults kind to 'agent' and parentSessionId to undefined", () => {
    const r = reg();
    const g = r.createGroup({ name: "g", projectDir: "/tmp/x" });
    const s = r.createSession({ groupId: g.id, name: "a", task: "t", worktreePath: "", branch: "b" });
    expect(s.kind).toBe("agent");
    expect(s.parentSessionId).toBeUndefined();
    expect(r.listSessions(g.id)[0]!.kind).toBe("agent");
  });

  it("persists kind='discussion' and parentSessionId", () => {
    const r = reg();
    const g = r.createGroup({ name: "g", projectDir: "/tmp/x" });
    const parent = r.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "b" });
    const child = r.createSession({
      groupId: g.id, name: "branch: AAA", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "discussion", parentSessionId: parent.id,
    });
    const read = r.listSessions(g.id).find((x) => x.id === child.id)!;
    expect(read.kind).toBe("discussion");
    expect(read.parentSessionId).toBe(parent.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.branch.spec.ts`
Expected: FAIL — `kind` is `undefined` (columns/reads not added yet).

- [ ] **Step 3: Add the idempotent migration**

In the constructor, after the `base_branch` migration block (currently ends ~line 59, just before the constructor's closing `}`), add:
```ts
    // Additive migration: discussion branches (parent link + session kind).
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'`);
    } catch {
      /* column already exists */
    }
```

- [ ] **Step 4: Read the new columns in `listSessions`**

In `listSessions` (line 94), add `parent_session_id as parentSessionId, kind` to the SELECT, before `status`:
```ts
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, status, archived, created_at as createdAt, last_activity_at as lastActivityAt FROM sessions`;
```
(The `rows.map` boolean fix at line 101 is unchanged; `kind`/`parentSessionId` pass through.)

- [ ] **Step 5: Persist on insert in `createSession`**

Change the param type (lines 104-107) to accept optional `kind`/`parentSessionId`:
```ts
  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "worktree" | "baseBranch" | "lastActivityAt" | "kind" | "parentSessionId"> & {
      status?: SessionStatus; worktree?: boolean; baseBranch?: string;
      kind?: Session["kind"]; parentSessionId?: string;
    },
  ): Session {
```
In the `row` object (after `baseBranch: s.baseBranch,`), add:
```ts
      kind: s.kind ?? "agent",
      parentSessionId: s.parentSessionId,
```
Extend the INSERT column list and values to include the two columns:
```ts
      .prepare(
        `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.groupId,
        row.name,
        row.task,
        row.worktreePath,
        row.branch,
        row.worktree ? 1 : 0,
        row.baseBranch ?? null,
        row.ompSessionId ?? null,
        row.ompSessionFile ?? null,
        row.parentSessionId ?? null,
        row.kind,
        row.status,
        row.createdAt,
        row.lastActivityAt,
      );
```
`kind`/`parentSessionId` are write-once at creation; `updateSession` is intentionally left untouched (SQLite `UPDATE` only rewrites listed columns, so these are preserved).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.branch.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/api/src/registry/registry.service.ts kermanych/apps/api/test/registry.branch.spec.ts
git commit -m "feat(api): registry persists session kind and parentSessionId"
```

---

### Task 3: `RpcSession` supports `--fork` and `--no-tools`

**Files:**
- Modify: `kermanych/apps/api/src/rpc/rpc-session.ts` (constructor opts line 36; `start()` argv lines 44-46)

**Interfaces:**
- Produces: `new RpcSession({ cwd, model?, ompPath?, fork?, noTools? })`; when set, spawns with `--fork <path>` and/or `--no-tools`.

- [ ] **Step 1: Extend constructor options**

Change the constructor signature (line 36):
```ts
  constructor(private opts: { cwd: string; model?: string; ompPath?: string; fork?: string; noTools?: boolean }) {}
```

- [ ] **Step 2: Add the flags to the spawn argv**

In `start()`, the argv build (lines 44-46) becomes:
```ts
    const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
    if (this.opts.model) argv.push("--model", this.opts.model);
    if (this.opts.fork) argv.push("--fork", this.opts.fork);
    if (this.opts.noTools) argv.push("--no-tools");
    if (this.opts.ompPath) argv[0] = this.opts.ompPath;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/api/src/rpc/rpc-session.ts
git commit -m "feat(api): RpcSession supports --fork and --no-tools"
```

---

### Task 4: Supervisor `branchSession` (fork a discussion child)

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (add method; import `messagesToTranscript` already present)
- Test: `kermanych/apps/api/test/supervisor.branch.spec.ts` (create)

**Interfaces:**
- Consumes: `RpcSession({ fork, noTools })` (Task 3); `registry.createSession({ kind, parentSessionId })` (Task 2); existing `wireLive`, `refreshState`, `merge`, `messagesToTranscript`, `getAllMessages`.
- Produces: `SupervisorService.branchSession(parentId: string): Promise<Session>`.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/supervisor.branch.spec.ts`. Mock `RpcSession` and stub `WorktreeService` so no omp process or git runs:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const started: any[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    opts: any;
    constructor(opts: any) { this.opts = opts; started.push(opts); }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "omp-child", sessionFile: "/tmp/child.jsonl" }; }
    async getAllMessages() { return [{ role: "assistant", content: [{ type: "text", text: "inherited" }] }]; }
    async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(), removeWorktree: vi.fn(), removeBranch: vi.fn(),
    createBranchHere: vi.fn(), checkout: vi.fn(), currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  } as any;
  const sup = new SupervisorService(registry, worktree);
  return { sup, registry, worktree };
}

beforeEach(() => { started.length = 0; });

describe("branchSession", () => {
  it("forks a discussion child with parent link and no git", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    // Seed a parent that already has an omp session file.
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    const child = await sup.branchSession(parent.id);

    expect(child.kind).toBe("discussion");
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.worktree).toBe(false);
    // Forked from the parent file, no tools, parent's cwd.
    expect(started.at(-1)).toMatchObject({ fork: "/tmp/aaa.jsonl", noTools: true, cwd: "/tmp/wt" });
  });

  it("rejects branching when the parent has no omp session file", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "b" });
    await expect(sup.branchSession(parent.id)).rejects.toThrow(/omp session/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.branch.spec.ts`
Expected: FAIL — `branchSession` is not a function.

- [ ] **Step 3: Implement `branchSession`**

Add this method to `SupervisorService` (e.g. right after `createSession`):
```ts
  // Fork a discussion child off a parent's omp conversation (tip-level). The child
  // runs in the parent's directory with no git and no editing tools, so the parent's
  // context is never touched and both run in parallel.
  async branchSession(parentId: string): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === parentId);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.kind === "discussion") throw new Error("cannot branch a discussion branch");

    let parentFile = s.ompSessionFile;
    if (!parentFile) {
      await this.refreshState(parentId);
      parentFile = this.registry.listSessions().find((x) => x.id === parentId)?.ompSessionFile;
    }
    if (!parentFile) throw new Error("agent has no omp session yet — send a first message before branching");

    const live = this.map.get(parentId);
    if (live && (live.state.status === "thinking" || live.state.status === "tool"))
      throw new Error("wait for the agent to finish its turn before branching");

    const cwd = s.worktreePath || g.projectDir;
    const child = this.registry.createSession({
      groupId: s.groupId,
      name: `гілка: ${s.name}`,
      task: "",
      worktreePath: "",
      branch: "",
      worktree: false,
      kind: "discussion",
      parentSessionId: parentId,
    });

    const rpc = new RpcSession({ cwd, fork: parentFile, noTools: true });
    const childLive = this.wireLive(child.id, rpc, "queued");
    try {
      await rpc.start();
      childLive.transcript = messagesToTranscript(await rpc.getAllMessages());
      this.events.next({ type: "transcript_reset", sessionId: child.id, entries: childLive.transcript });
      await this.refreshState(child.id);
      childLive.live.status = "done";
      this.registry.updateSession(child.id, { status: "done" });
    } catch (err) {
      this.stopPoll(childLive);
      await rpc.stop().catch(() => {});
      this.map.delete(child.id);
      this.registry.removeSession(child.id);
      this.events.next({ type: "session_removed", sessionId: child.id });
      throw err;
    }
    this.pushUpdate(child.id);
    return this.merge(child);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.branch.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/supervisor.branch.spec.ts
git commit -m "feat(api): supervisor branchSession forks a discussion child"
```

---

### Task 5: Supervisor `mergeDiscussion` (inject summary into parent)

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (add method)
- Test: `kermanych/apps/api/test/supervisor.merge.spec.ts` (create)

**Interfaces:**
- Consumes: existing `sendMessage(id, text, mode)`; `map` (live transcript + status).
- Produces: `SupervisorService.mergeDiscussion(childId: string, summary?: string): Promise<{ merged: true }>`.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/supervisor.merge.spec.ts` (reuse the same `RpcSession` mock + `make()` helper as Task 4 — copy them into this file; the engineer may read tasks out of order):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const started: any[] = [];
const prompts: { text: string }[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    opts: any;
    constructor(opts: any) { this.opts = opts; started.push(opts); }
    onEvent() {} onExit() {}
    async start() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    prompt(text: string) { prompts.push({ text }); }
    followUp(text: string) { prompts.push({ text }); }
    steer(text: string) { prompts.push({ text }); }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = { currentBranch: vi.fn().mockResolvedValue("main") } as any;
  return { sup: new SupervisorService(registry, worktree), registry };
}
beforeEach(() => { started.length = 0; prompts.length = 0; });

describe("mergeDiscussion", () => {
  it("injects the summary into the parent and marks the child merged", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id); // needs Task 4
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;

    await sup.mergeDiscussion(child.id, "use cookies");

    expect(prompts.at(-1)!.text).toContain("use cookies");
    expect(prompts.at(-1)!.text).toContain("Висновок гілки");
    expect(registry.listSessions(g.id).find((x) => x.id === child.id)!.status).toBe("merged");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.merge.spec.ts`
Expected: FAIL — `mergeDiscussion` is not a function.

- [ ] **Step 3: Implement `mergeDiscussion`**

Add to `SupervisorService`:
```ts
  // Merge a discussion branch back into its parent: inject a (reviewed) summary as a
  // message into the parent's live conversation, then retire the child as merged history.
  async mergeDiscussion(childId: string, summary?: string): Promise<{ merged: true }> {
    const c = this.registry.listSessions().find((x) => x.id === childId);
    if (!c) throw new Error("session not found");
    if (c.kind !== "discussion" || !c.parentSessionId) throw new Error("not a discussion branch");
    const parentId = c.parentSessionId;

    const live = this.map.get(childId);
    const last = [...(live?.transcript ?? [])]
      .reverse()
      .find((e) => e.kind === "assistant_text") as { kind: "assistant_text"; text: string } | undefined;
    const text = (summary?.trim() || last?.text || "").trim();
    if (!text) throw new Error("nothing to merge — the branch has no conclusion yet");
    const wrapped = `[Висновок гілки «${c.name}»]: ${text}`;

    const parentLive = this.map.get(parentId);
    const mode: "prompt" | "follow_up" =
      parentLive && (parentLive.state.status === "thinking" || parentLive.state.status === "tool")
        ? "follow_up"
        : "prompt";
    // sendMessage resumes a dormant parent; if it throws, the child is left intact.
    await this.sendMessage(parentId, wrapped, mode);

    if (live) {
      live.live.status = "stopped";
      this.stopPoll(live);
      await live.rpc.stop();
      this.map.delete(childId);
    }
    this.registry.updateSession(childId, { status: "merged" });
    this.pushUpdate(childId);
    return { merged: true };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.merge.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/supervisor.merge.spec.ts
git commit -m "feat(api): supervisor mergeDiscussion injects summary into parent"
```

---

### Task 6: Discard + cascade + guard fixes

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (`deleteSession` lines 281-306; `createSession` in-place guard lines 100-102; `doResume` guard line 460; `finishSession` line 340)
- Test: `kermanych/apps/api/test/supervisor.discard.spec.ts` (create)

**Interfaces:**
- Consumes: `node:fs/promises` `rm`.
- Produces: `deleteSession` handles discussion children (no git, best-effort fork-file removal) and cascade-deletes children; `finishSession` rejects discussion; guards exclude discussion.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/supervisor.discard.spec.ts` (reuse the `RpcSession` mock + `make()` from Task 4; the `worktree` stub records git calls):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const started: any[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: any) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {} async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; } async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    removeWorktree: vi.fn(), removeBranch: vi.fn(), checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as any;
  return { sup: new SupervisorService(registry, worktree), registry, worktree };
}
beforeEach(() => { started.length = 0; });

describe("discard + cascade", () => {
  it("deletes a discussion child without any git calls", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;

    await sup.deleteSession(child.id);

    expect(registry.listSessions(g.id).find((x) => x.id === child.id)).toBeUndefined();
    expect(worktree.removeBranch).not.toHaveBeenCalled();
    expect(worktree.checkout).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("cascade-deletes children when the parent is deleted", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "feature/aaa", worktree: false, baseBranch: "main" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    expect(registry.listSessions(g.id).some((x) => x.kind === "discussion")).toBe(true);

    await sup.deleteSession(parent.id);

    expect(registry.listSessions(g.id)).toHaveLength(0);
  });

  it("refuses finishSession on a discussion branch", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
    await expect(sup.finishSession(child.id)).rejects.toThrow(/discussion/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.discard.spec.ts`
Expected: FAIL — the discussion child triggers git calls / finishSession does not reject.

- [ ] **Step 3: Add the fs import**

At the top of `supervisor.service.ts`, alongside the existing `node:child_process` import:
```ts
import { rm } from "node:fs/promises";
```

- [ ] **Step 4: Rewrite `deleteSession` for cascade + discussion**

Replace the body of `deleteSession` (lines 281-306) with:
```ts
  async deleteSession(id: string) {
    // Cascade: discussion branches hang off this session — discard them first.
    for (const child of this.registry.listSessions().filter((x) => x.parentSessionId === id))
      await this.deleteSession(child.id);

    const s = this.registry.listSessions().find((x) => x.id === id);
    const l = this.map.get(id);
    if (l) {
      l.live.status = "stopped";
      this.stopPoll(l);
      await l.rpc.stop();
      this.map.delete(id);
    }
    if (s && s.kind === "discussion") {
      // No git: the child owns no branch/worktree; its cwd is the parent's.
      if (s.ompSessionFile) await rm(s.ompSessionFile, { force: true }).catch(() => {});
    } else if (s) {
      const g = this.registry.listGroups().find((x) => x.id === s.groupId);
      if (g) {
        if (s.worktree) {
          if (s.worktreePath) await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
        } else if (s.baseBranch && (await this.worktree.currentBranch(g.projectDir)) === s.branch) {
          await this.worktree
            .checkout(g.projectDir, s.baseBranch)
            .catch(() => this.worktree.checkout(g.projectDir, s.baseBranch!, { force: true }));
        }
        await this.worktree.removeBranch(g.projectDir, s.branch);
      }
    }
    this.registry.removeSession(id);
    this.events.next({ type: "session_removed", sessionId: id });
  }
```

- [ ] **Step 5: Exclude discussion from the in-place single-active guard**

In `createSession`, change the `activeInPlace` check (line 100-102):
```ts
      const activeInPlace = this.registry
        .listSessions(groupId)
        .some((s) => !s.worktree && s.kind !== "discussion" && s.status !== "merged");
```

- [ ] **Step 6: Skip the branch guard in `doResume` for discussion**

In `doResume`, change the guard (line 460):
```ts
    if (s.kind !== "discussion" && !s.worktree && (await this.worktree.currentBranch(g.projectDir)) !== s.branch)
      throw new Error(`project is not on ${s.branch} — switch to it or delete the agent`);
```

- [ ] **Step 7: Reject `finishSession` on a discussion branch**

At the start of `finishSession`, after the `s`/`g` lookups (right before the `if (s.worktree) {` block, ~line 345):
```ts
    if (s.kind === "discussion")
      throw new Error("discussion branches can't be finished — merge or discard instead");
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.discard.spec.ts`
Expected: PASS (all three cases).

- [ ] **Step 9: Run the full api test suite**

Run: `pnpm --filter @kermanych/api exec vitest run`
Expected: PASS (Tasks 2/4/5/6 specs green; existing specs unaffected).

- [ ] **Step 10: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/supervisor.discard.spec.ts
git commit -m "feat(api): discussion discard/cascade + guard fixes"
```

---

### Task 7: REST endpoints `POST :id/branch` and `POST :id/merge`

**Files:**
- Modify: `kermanych/apps/api/src/http/sessions.controller.ts` (add two handlers after the `message` handler, ~line 40)

**Interfaces:**
- Consumes: `sup.branchSession(id)`, `sup.mergeDiscussion(id, summary)`.
- Produces: `POST /api/sessions/:id/branch` → `Session`; `POST /api/sessions/:id/merge` `{ summary? }` → `{ merged: true }`.

- [ ] **Step 1: Add the handlers**

After the `message` handler (line 40) add:
```ts
  @Post(":id/branch")
  async branch(@Param("id") id: string) {
    try {
      return await this.sup.branchSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/merge")
  async merge(@Param("id") id: string, @Body() b: { summary?: string }) {
    try {
      return await this.sup.mergeDiscussion(id, b.summary);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
```

- [ ] **Step 2: Typecheck the api**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add kermanych/apps/api/src/http/sessions.controller.ts
git commit -m "feat(api): add /sessions/:id/branch and /merge endpoints"
```

---

### Task 8: UI api client + store actions

**Files:**
- Modify: `kermanych/apps/ui/src/lib/api.ts` (add to the `api` object, ~line 133)
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts` (add actions + export)

**Interfaces:**
- Consumes: the REST endpoints (Task 7).
- Produces: `store.branchSession(id): Promise<Session>`, `store.mergeBranch(id, summary?): Promise<{ merged: boolean }>`.

- [ ] **Step 1: Add the api methods**

In `api.ts`, inside the `api` object (before the closing `}` at line 134):
```ts
  branchSession: (id: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/branch`, {}),

  mergeBranch: (id: string, summary?: string): Promise<{ merged: boolean }> =>
    post<{ merged: boolean }>(`/sessions/${id}/merge`, { summary }),
```

- [ ] **Step 2: Add the store actions and export them**

In `orchestrator.ts`, near the other delegating actions (after `deleteSession`, ~line 114):
```ts
  function branchSession(id: string) {
    return api.branchSession(id);
  }

  function mergeBranch(id: string, summary?: string) {
    return api.mergeBranch(id, summary);
  }
```
Add `branchSession,` and `mergeBranch,` to the returned object (near `deleteSession,` in the `return { … }` block, ~line 197).

- [ ] **Step 3: Typecheck the ui**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui/src/lib/api.ts kermanych/apps/ui/src/stores/orchestrator.ts
git commit -m "feat(ui): api + store actions for branch/merge"
```

---

### Task 9: UI branch trigger (KPanel header ⑂)

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KPanel.vue` (emits line 185-192; header controls line 10-39)
- Modify: `kermanych/apps/ui/src/pages/WorkspacePage.vue` (bind `@branch`; add `onBranch`)

**Interfaces:**
- Consumes: `store.branchSession(id)` (Task 8).
- Produces: KPanel emits `branch`; WorkspacePage `onBranch()` creates a child and selects it.

> **v1 note (review point):** the trigger is a `⑂` button in the chat panel header, shown only for `kind === "agent"`. It branches the current conversation at its tip (v1 is tip-level). The per-message hover `⑂` on `KLogBlock` is the entry-level follow-up (deferred). This is a deliberate simplification of spec §9's trigger location; behavior is unchanged.

- [ ] **Step 1: Add the `branch` emit to KPanel**

In `KPanel.vue`, extend `defineEmits` (line 185-192):
```ts
const emit = defineEmits<{
  stop: [];
  delete: [];
  send: [text: string, images: ImageInput[]];
  answer: [res: RpcExtensionUIResponse];
  finish: [];
  editor: [];
  branch: [];
}>();
```

- [ ] **Step 2: Add the header button**

In the `.k-panel__controls` block, before the stop button (line 12), add:
```html
        <button
          v-if="session.kind === 'agent'"
          class="k-panel__icon"
          type="button"
          title="Обговорити окрему гілку (форк розмови)"
          @click="emit('branch')"
        >⑂</button>
```

- [ ] **Step 3: Wire it in WorkspacePage**

On the `<KPanel …>` usage (line 120-130), add `@branch="onBranch"` to the event bindings.

Add the handler near `onSend` (~line 526):
```ts
async function onBranch(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    const child = await store.branchSession(s.id);
    if (child?.id) store.selectSession(child.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KPanel.vue kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): branch trigger in chat panel header"
```

---

### Task 10: UI board — nested discussion rows + row actions

**Files:**
- Modify: `kermanych/apps/ui/src/pages/WorkspacePage.vue` (`boardRows` computed; KTable `:rows`; `cell-name`, `cell-branch`, `cell-actions` slots; add `openMerge`/`onDiscardRow`; styles)

**Interfaces:**
- Consumes: `store.mergeBranch`, `store.deleteSession`, `store.transcripts` (for the summary default).
- Produces: discussion children render nested under their parent with `⤴`/`✕` actions; `openMerge(s)` opens the merge modal (Task 11).

- [ ] **Step 1: Add the ordered `boardRows` computed**

After `groupSessions` (line 332) add:
```ts
// Board order: each discussion child immediately follows its parent (a one-level
// tree). Orphans (parent filtered out by the archived/group view) still render.
const boardRows = computed<Session[]>(() => {
  const all = groupSessions.value;
  const parents = all.filter((s) => !s.parentSessionId);
  const out: Session[] = [];
  for (const p of parents) {
    out.push(p);
    for (const c of all.filter((s) => s.parentSessionId === p.id)) out.push(c);
  }
  for (const s of all) if (!out.includes(s)) out.push(s);
  return out;
});
```

- [ ] **Step 2: Point the table at `boardRows`**

Change the KTable `:rows="groupSessions"` (line 27) to `:rows="boardRows"`.

- [ ] **Step 3: Nested name cell**

Replace the `#cell-name` slot (lines 40-42):
```html
          <template #cell-name="{ row }">
            <span class="ws__cell-name" :class="{ 'ws__cell-name--child': row.kind === 'discussion' }">
              <span v-if="row.kind === 'discussion'" class="ws__branch-connector" aria-hidden="true">└</span>
              {{ row.name }}
              <KTag v-if="row.kind === 'discussion'">discussion</KTag>
            </span>
          </template>
```

- [ ] **Step 4: Branch cell tolerates the empty branch**

Replace the `#cell-branch` slot (lines 43-45):
```html
          <template #cell-branch="{ row }">
            <KTag v-if="row.branch">⑂ {{ row.branch }}</KTag>
            <span v-else class="mono ws__cell-activity">—</span>
          </template>
```

- [ ] **Step 5: Discussion row actions**

Replace the `#cell-actions` slot body (lines 55-87) so discussion rows get merge/discard while agents keep the existing actions:
```html
          <template #cell-actions="{ row }">
            <div class="ws__cell-actions">
              <template v-if="row.kind === 'discussion'">
                <button
                  v-if="row.status !== 'merged'"
                  type="button"
                  class="ws__card-icon"
                  title="Влити висновок у батьківського агента"
                  @click.stop="openMerge(row)"
                >⤴</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Викинути гілку"
                  @click.stop="onDiscardRow(row)"
                >✕</button>
              </template>
              <template v-else-if="!showArchived">
                <button
                  type="button"
                  class="ws__card-icon"
                  :class="{ 'ws__card-icon--on': store.previews[row.id] }"
                  :title="store.previews[row.id] ? 'Зупинити превʼю' : 'Превʼю гілки в браузері'"
                  @click.stop="togglePreview(row)"
                >{{ store.previews[row.id] ? '◼' : '▶' }}</button>
                <button
                  v-if="row.status !== 'merged'"
                  type="button"
                  class="ws__card-icon"
                  title="Завершити (merge гілки в проєкт)"
                  @click.stop="openFinish(row)"
                >✓</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Заархівувати"
                  @click.stop="onArchive(row)"
                >⤓</button>
              </template>
              <button
                v-else
                type="button"
                class="ws__card-icon"
                title="Розархівувати"
                @click.stop="onUnarchive(row)"
              >⤒</button>
            </div>
          </template>
```

- [ ] **Step 6: Add merge state + `openMerge`/`submitMerge`/`onDiscardRow`**

Near the finish state/handlers (~line 579) add:
```ts
// ── Merge / discard a discussion branch ──────────────────────────────────
const mergeOpen = ref(false);
const mergeFor = ref<Session | null>(null);
const mergeSummary = ref('');
const mergeBusy = ref(false);
const mergeError = ref<string | null>(null);

function openMerge(s: Session): void {
  mergeFor.value = s;
  mergeError.value = null;
  mergeBusy.value = false;
  const t = store.transcripts[s.id] ?? [];
  const last = [...t].reverse().find((e) => e.kind === 'assistant_text') as
    | { kind: 'assistant_text'; text: string }
    | undefined;
  mergeSummary.value = last?.text ?? '';
  mergeOpen.value = true;
}

async function submitMerge(): Promise<void> {
  const s = mergeFor.value;
  if (!s) return;
  mergeBusy.value = true;
  mergeError.value = null;
  try {
    await store.mergeBranch(s.id, mergeSummary.value.trim() || undefined);
    mergeOpen.value = false;
    if (s.parentSessionId) store.selectSession(s.parentSessionId);
  } catch (e) {
    mergeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    mergeBusy.value = false;
  }
}

function onDiscardRow(s: Session): void {
  if (!window.confirm(`Викинути гілку «${s.name}»? Розмову буде втрачено.`)) return;
  void store.deleteSession(s.id).then(() => {
    if (store.selectedSessionId === s.id) store.selectSession(undefined);
  });
}
```

- [ ] **Step 7: Add the nested-row styles**

In the component `<style scoped>` block, add:
```scss
.ws__cell-name--child { padding-left: 6px; color: var(--k-muted); }
.ws__branch-connector { color: var(--k-accent); margin-right: 4px; }
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): nested discussion rows + merge/discard actions"
```

---

### Task 11: UI merge modal

**Files:**
- Modify: `kermanych/apps/ui/src/pages/WorkspacePage.vue` (add the merge `KModal` near the finish modal)

**Interfaces:**
- Consumes: merge state + `openMerge`/`submitMerge` (Task 10 Step 6); `KModal`/`KBtn`.
- Produces: the visible merge modal wired to `submitMerge`.

- [ ] **Step 1: Add the modal markup**

After the new-agent launcher `KModal` (before the preview-config modal, ~line 202) add:
```html
    <!-- MERGE — pour a discussion branch's conclusion into its parent -->
    <KModal v-model="mergeOpen" title="Влити гілку в батьківського агента">
      <div class="ws__form">
        <label class="ws__field">
          <span class="ws__field-label">Summary (піде як повідомлення в батьківського агента)</span>
          <textarea
            v-model="mergeSummary"
            class="ws__textarea mono"
            rows="6"
            placeholder="Порожнє — візьму останню відповідь гілки"
          />
        </label>
        <p class="ws__hint mono">
          Батьківський агент отримає це й почне діяти. Гілка стане історією
          (<code class="mono">merged</code>).
        </p>
        <p v-if="mergeError" class="ws__error" role="alert">{{ mergeError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="mergeOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="mergeBusy" @click="submitMerge">⤴ Влити</KBtn>
      </template>
    </KModal>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): merge-summary modal for discussion branches"
```

---

### Task 12: End-to-end smoke verification (the feature's proof)

**Files:** none (manual run). Requires `omp` on PATH, authenticated.

- [ ] **Step 1: Build + start**

Run: `pnpm install && pnpm dev:api` (one terminal) and `pnpm dev:ui` (another). Open http://localhost:5317.

- [ ] **Step 2: Branch → discuss → merge**

1. Create/open a group and an agent (AAA); send it a first message so it has an omp session.
2. In AAA's chat header, click `⑂`. Expect a nested `гілка: AAA · discussion` row under AAA, opened in the chat with AAA's inherited conversation visible.
3. Send a message in the branch; confirm AAA's own row/chat did NOT change.
4. Click `⤴` on the branch row → edit the summary → `⤴ Влити`. Expect: the summary appears as a message in AAA's chat and AAA starts a turn; the branch row flips to `влито` (merged) and stays as history.

- [ ] **Step 3: Branch → discard, and cascade**

1. Branch AAA again; click `✕` on the branch row → confirm. Expect the row disappears and `git -C <project> branch` shows **no** new branch (discussion creates none).
2. Branch AAA again, then delete AAA. Expect the branch row is cascade-removed with it.

- [ ] **Step 4: Full suites (final gate)**

Run: `pnpm --filter @kermanych/core exec vitest run && pnpm --filter @kermanych/api exec vitest run`
Then: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A && git commit -m "test: discussion-branches smoke fixups"   # only if changes were needed
```

## Notes / deferred

- Entry-level branching (per-message `⑂` on `KLogBlock`, forking at a chosen entry) needs omp entry ids surfaced through the transcript; add a `branch_entry_id` column then. Not in v1.
- Deep nesting (branch of a branch) is blocked in `branchSession` (`kind === "discussion"` rejected) for v1; the board `boardRows` renders one level.
- `KModal`, `KBtn`, `KTag`, `KTable` props/slots used above are the existing ones — no kit changes required beyond `KPanel`'s new `branch` emit.
