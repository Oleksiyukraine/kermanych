# Worktree Toggle & Branch Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator, when launching an agent, pick a branch prefix (`feature`/`fix`/`refactoring`/`chore`) and toggle worktree isolation off to run the agent in-place in the project dir on a new branch.

**Architecture:** Branch name becomes `<prefix>/<slug>` (was fixed `kermanych/<slug>`). A new `Session.worktree` boolean selects isolation: `true` (default) keeps the current dedicated-worktree flow; `false` runs `omp` directly in `group.projectDir` after `git checkout -b`, storing the project's prior branch in `Session.baseBranch` so finish/delete can restore it. A single `sessionDir(s, group) = s.worktreePath || group.projectDir` anchor feeds every worktree-touching path (resume, preview, editor, finish, resolve, delete).

**Tech Stack:** TypeScript, NestJS (`apps/api`), Quasar/Vue 3 (`apps/ui`), `@kermanych/core` (shared domain), `better-sqlite3`, vitest.

## Global Constraints

- **Node 22.x** required (native `better-sqlite3`).
- **pnpm** workspace; run from repo `kermanych/` dir.
- **TDD**: failing test → implement → pass → commit. Frequent commits.
- **Additive-only DB migrations** wrapped in `try/catch` (mirror the existing `archived` column pattern). No destructive schema changes.
- **Branch prefixes are a fixed list**: `['feature','fix','refactoring','chore']`. Default `feature`.
- **Worktree default is `true`** — existing callers/behavior unchanged unless the flag is explicitly `false`.
- **One live in-place agent per group** (a group is one project dir); worktree agents are unlimited.
- **UI copy is Ukrainian**; custom `K*` components only, design tokens (`--k-*`), radius 0, single accent.
- **Do NOT pull Node built-ins into the browser bundle.** The UI imports `BranchPrefix` as a **type-only** import; it never imports runtime values from `@kermanych/core` (the barrel re-exports `worktreeDir`, which uses `os`/`path`).
- Test commands (from `kermanych/`):
  - core: `pnpm --filter @kermanych/core exec vitest run <file>`
  - api: `pnpm --filter @kermanych/api exec vitest run <file>`
  - api typecheck/build: `pnpm --filter @kermanych/api build`

---

### Task 1: Core — branch prefix + session fields

**Files:**
- Modify: `kermanych/packages/core/src/worktree-names.ts`
- Modify: `kermanych/packages/core/src/types.ts:12-19` (the `Session` type)
- Test: `kermanych/packages/core/test/worktree-names.spec.ts`

**Interfaces:**
- Produces:
  - `export const BRANCH_PREFIXES = ['feature','fix','refactoring','chore'] as const;`
  - `export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];`
  - `branchName(slug: string, prefix?: BranchPrefix): string` → `` `${prefix}/${slug}` ``, default `prefix = 'feature'`.
  - `Session.worktree: boolean` (required) and `Session.baseBranch?: string`.
  - Unchanged: `slugify`, `uniqueSlug`, `worktreeDir`.

- [ ] **Step 1: Update the failing test**

Replace the `branchName` test and add a prefix test in `worktree-names.spec.ts`:

```ts
import { expect, test } from "vitest";
import { slugify, branchName, uniqueSlug, BRANCH_PREFIXES } from "../src/worktree-names";

test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("branchName defaults to the feature prefix", () => {
  expect(branchName("fix-login")).toBe("feature/fix-login");
});
test("branchName uses the given prefix", () => {
  expect(branchName("fix-login", "fix")).toBe("fix/fix-login");
});
test("BRANCH_PREFIXES lists the four allowed prefixes", () => {
  expect([...BRANCH_PREFIXES]).toEqual(["feature", "fix", "refactoring", "chore"]);
});
test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("fix", new Set(["fix", "fix-2"]))).toBe("fix-3");
  expect(uniqueSlug("fix", new Set())).toBe("fix");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/worktree-names.spec.ts`
Expected: FAIL — `branchName` returns `kermanych/...`; `BRANCH_PREFIXES` is undefined.

- [ ] **Step 3: Implement the core changes**

In `worktree-names.ts`, replace the `branchName` line and add the prefix consts (keep `slugify`, `uniqueSlug`, `worktreeDir` and the `os`/`path` imports untouched):

```ts
export const BRANCH_PREFIXES = ["feature", "fix", "refactoring", "chore"] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

export function branchName(slug: string, prefix: BranchPrefix = "feature"): string {
  return `${prefix}/${slug}`;
}
```

In `types.ts`, add two fields to `Session` (after `worktreePath: string; branch: string;` on line 14):

```ts
  worktree: boolean; baseBranch?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kermanych && pnpm --filter @kermanych/core exec vitest run test/worktree-names.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add kermanych/packages/core/src/worktree-names.ts kermanych/packages/core/src/types.ts kermanych/packages/core/test/worktree-names.spec.ts
git commit -m "feat(core): branch prefixes + session worktree/baseBranch fields"
```

---

### Task 2: Registry — persist `worktree` + `baseBranch`

**Files:**
- Modify: `kermanych/apps/api/src/registry/registry.service.ts` (migrations ~line 35-40; `listSessions` 74-83; `createSession` 85-111; `updateSession` 113-133)
- Test: `kermanych/apps/api/test/registry.spec.ts`

**Interfaces:**
- Consumes: `Session.worktree`, `Session.baseBranch` (Task 1).
- Produces: `createSession(s)` where `s` is
  `Omit<Session,"id"|"createdAt"|"status"|"worktree"|"baseBranch"> & { status?: SessionStatus; worktree?: boolean; baseBranch?: string }`;
  `worktree` defaults to `true`, `baseBranch` to `undefined`. `listSessions`/`updateSession` round-trip both.

- [ ] **Step 1: Write the failing test**

Append to `registry.spec.ts`:

```ts
test("session worktree flag defaults true and round-trips with baseBranch", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });

  const wtSession = r.createSession({ groupId: g.id, name: "wt", task: "t", worktreePath: "/wt", branch: "feature/wt" });
  expect(wtSession.worktree).toBe(true);
  expect(r.listSessions(g.id).find((s) => s.id === wtSession.id)!.worktree).toBe(true);

  const inPlace = r.createSession({
    groupId: g.id, name: "ip", task: "t", worktreePath: "", branch: "fix/ip",
    worktree: false, baseBranch: "main",
  });
  const read = r.listSessions(g.id).find((s) => s.id === inPlace.id)!;
  expect(read.worktree).toBe(false);
  expect(read.baseBranch).toBe("main");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts`
Expected: FAIL — `worktree` is `undefined` (column/mapping missing).

- [ ] **Step 3: Implement the migrations + CRUD**

Add migrations after the `archived` block (after line 40), each in its own try/catch:

```ts
    // Additive migration: worktree isolation toggle + in-place base branch.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree INTEGER NOT NULL DEFAULT 1`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN base_branch TEXT`);
    } catch {
      /* column already exists */
    }
```

`listSessions` — add columns to the SELECT and map (line 75 SELECT, line 80-82 mapping):

```ts
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, archived, created_at as createdAt FROM sessions`;
    const rows = (
      groupId
        ? this.db.prepare(sql + ` WHERE group_id = ? ORDER BY created_at`).all(groupId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree"> & { archived: number; worktree: number })[];
    // SQLite stores flags as 0/1; hand callers real booleans.
    return rows.map((r) => ({ ...r, archived: r.archived !== 0, worktree: r.worktree !== 0 }));
```

`createSession` — widen the arg type and insert the new columns:

```ts
  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "worktree" | "baseBranch"> & {
      status?: SessionStatus; worktree?: boolean; baseBranch?: string;
    },
  ): Session {
    const row: Session = {
      ...s,
      worktree: s.worktree ?? true,
      baseBranch: s.baseBranch,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: s.status ?? "queued",
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.groupId, row.name, row.task, row.worktreePath, row.branch,
        row.worktree ? 1 : 0, row.baseBranch ?? null,
        row.ompSessionId ?? null, row.ompSessionFile ?? null, row.status, row.createdAt,
      );
    return row;
  }
```

`updateSession` — persist both columns (extend the UPDATE and `.run(...)`):

```ts
    this.db
      .prepare(
        `UPDATE sessions SET name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, status=?, archived=? WHERE id=?`,
      )
      .run(
        next.name, next.task, next.worktreePath, next.branch,
        next.worktree ? 1 : 0, next.baseBranch ?? null,
        next.ompSessionId ?? null, next.ompSessionFile ?? null, next.status,
        next.archived ? 1 : 0, id,
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts`
Expected: PASS (all registry tests, including the two pre-existing ones — their `createSession` calls omit `worktree` and now default to `true`).

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/registry/registry.service.ts kermanych/apps/api/test/registry.spec.ts
git commit -m "feat(api): persist session worktree flag + baseBranch"
```

---

### Task 3: WorktreeService — in-place git primitives

**Files:**
- Modify: `kermanych/apps/api/src/worktree/worktree.service.ts`
- Test: `kermanych/apps/api/test/worktree.spec.ts` (create)

**Interfaces:**
- Produces:
  - `checkout(dir: string, ref: string, opts?: { force?: boolean }): Promise<void>` → `git checkout [-f] <ref>`; throws on failure.
  - `createBranchHere(dir: string, branch: string): Promise<void>` → `git checkout -b <branch>`; throws on failure.

- [ ] **Step 1: Write the failing test**

Create `worktree.spec.ts`:

```ts
// apps/api/test/worktree.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-wt-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("createBranchHere creates and switches to the branch in place", async () => {
  await wt.createBranchHere(repo, "feature/x");
  expect(git(repo, "branch", "--show-current").trim()).toBe("feature/x");
});

test("checkout switches branches; force checkout discards uncommitted work", async () => {
  await wt.createBranchHere(repo, "feature/x");
  writeFileSync(join(repo, "file.txt"), "dirty\n"); // uncommitted change on the branch
  await wt.checkout(repo, "dev", { force: true });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("base"); // discarded
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/worktree.spec.ts`
Expected: FAIL — `wt.createBranchHere is not a function`.

- [ ] **Step 3: Implement the primitives**

Add to `WorktreeService` (after `mergeInto`, before `unmergedFiles`):

```ts
  // Create a branch and switch to it in `dir` (in-place mode: no separate worktree).
  async createBranchHere(dir: string, branch: string): Promise<void> {
    const r = await git(dir, ["checkout", "-b", branch]);
    if (!r.ok) throw new Error(`git checkout -b failed: ${r.out}`);
  }

  // Switch `dir` to `ref`. `force` (-f) discards local changes — used when retiring
  // an in-place session, where the working-tree changes belong to that session.
  async checkout(dir: string, ref: string, opts?: { force?: boolean }): Promise<void> {
    const args = opts?.force ? ["checkout", "-f", ref] : ["checkout", ref];
    const r = await git(dir, args);
    if (!r.ok) throw new Error(`git checkout failed: ${r.out}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/worktree.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/worktree/worktree.service.ts kermanych/apps/api/test/worktree.spec.ts
git commit -m "feat(api): worktree service checkout + createBranchHere"
```

---

### Task 4: Supervisor — `createSession` prefix, worktree flag, in-place guards

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts:82-117` (`createSession`), import `BranchPrefix` (line 9-25 import block)
- Test: `kermanych/apps/api/test/create-guards.spec.ts` (create)

**Interfaces:**
- Consumes: `branchName`, `slugify`, `uniqueSlug`, `BranchPrefix` (core); `createBranchHere` (Task 3); `Session.worktree`/`baseBranch` (Tasks 1-2).
- Produces: `createSession(groupId: string, name: string, task: string, model?: string, images?: ImageInput[], worktree?: boolean, prefix?: BranchPrefix): Promise<Session>` — `worktree` defaults `true`, `prefix` defaults `'feature'`. In-place guards throw **before** any registry row, branch, or `omp` process is created.

- [ ] **Step 1: Write the failing test**

Create `create-guards.spec.ts` (guards throw before spawning `omp`, so no real agent is started):

```ts
// apps/api/test/create-guards.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-guard-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("in-place create is refused on a dirty project tree and creates nothing", async () => {
  const g = reg.createGroup({ name: "g", projectDir: repo });
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // uncommitted
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/clean/i);
  expect(reg.listSessions(g.id)).toHaveLength(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // branch untouched
});

test("in-place create is refused when one is already active in the group", async () => {
  const g = reg.createGroup({ name: "g", projectDir: repo });
  reg.createSession({
    groupId: g.id, name: "a", task: "t", worktreePath: "", branch: "feature/a",
    worktree: false, baseBranch: "dev", status: "thinking",
  });
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/already active/i);
});

test("in-place create is refused on a detached HEAD", async () => {
  const g = reg.createGroup({ name: "g", projectDir: repo });
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", head); // detached
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/detached/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/create-guards.spec.ts`
Expected: FAIL — `createSession` ignores the `worktree` arg (spawns/hangs or wrong error), guards absent.

- [ ] **Step 3: Implement `createSession`**

Add `BranchPrefix` to the core import block (line 9-25). Replace the body of `createSession` (82-117) with:

```ts
  async createSession(
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = "feature",
  ): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");

    // In-place guards run first — they must not leave a row, branch, or omp process behind.
    let baseBranch: string | undefined;
    if (!worktree) {
      if (await this.worktree.hasUncommitted(group.projectDir))
        throw new Error("project working tree must be clean to create an in-place (non-worktree) agent");
      const activeInPlace = this.registry
        .listSessions(groupId)
        .some((s) => !s.worktree && s.status !== "merged");
      if (activeInPlace)
        throw new Error("an in-place agent is already active in this project — finish or delete it first");
      baseBranch = await this.worktree.currentBranch(group.projectDir);
      if (!baseBranch) throw new Error("project has a detached HEAD — checkout a branch first");
    }

    // Branch name: <prefix>/<slug>, de-duplicated against ALL existing session branches.
    const existing = new Set(this.registry.listSessions(groupId).map((s) => s.branch));
    const branch = uniqueSlug(branchName(slugify(name), prefix), existing);

    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch, worktree, baseBranch });
    let wtDir = "";
    try {
      if (worktree) {
        wtDir = worktreeDir(session.id);
        await this.worktree.addWorktree(group.projectDir, wtDir, branch);
      } else {
        await this.worktree.createBranchHere(group.projectDir, branch);
      }
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    const saved = worktree
      ? this.registry.updateSession(session.id, { worktreePath: wtDir })
      : session;

    const rpc = new RpcSession({ cwd: worktree ? wtDir : group.projectDir, model });
    const live = this.wireLive(session.id, rpc, "queued");
    try {
      await rpc.start();
      this.appendEntry(session.id, this.userEntry(task, images));
      rpc.prompt(task, images);
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      if (worktree) {
        await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      } else if (baseBranch) {
        await this.worktree.checkout(group.projectDir, baseBranch, { force: true }).catch(() => {});
      }
      await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      this.map.delete(session.id);
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    this.pushUpdate(session.id);
    return this.merge(saved);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/create-guards.spec.ts`
Expected: PASS (3 tests). Also run the whole api suite to confirm no regressions: `cd kermanych && pnpm --filter @kermanych/api exec vitest run`.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/create-guards.spec.ts
git commit -m "feat(api): createSession honors prefix + worktree flag with in-place guards"
```

---

### Task 5: Supervisor — in-place finish / finishInfo / delete

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` — `finishInfo` (262-272), `finishSession` (278-316), `deleteSession` (228-246)
- Test: `kermanych/apps/api/test/finish.spec.ts` (extend)

**Interfaces:**
- Consumes: `checkout`, `createBranchHere` (Task 3); `Session.worktree`/`baseBranch`.
- Produces (behavior): for `worktree === false` sessions, finish merges `branch` into `baseBranch` in `projectDir` and restores `projectDir` to `baseBranch`; on conflict it leaves markers on the session branch in `projectDir` (status `conflict`); delete restores `baseBranch` and removes the branch. `finishInfo` reports `target = baseBranch`. Worktree-mode behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `finish.spec.ts` (reuses the module `repo`/`reg`/`sup`/`wt`/`git` from the existing setup):

```ts
// In-place: the session branch lives in the project repo itself (no worktree).
async function seedInPlace(mutate: () => void): Promise<{ id: string }> {
  const g = reg.createGroup({ name: "g", projectDir: repo });
  await wt.createBranchHere(repo, "feature/s1"); // repo now checked out on the session branch
  mutate();
  const s = reg.createSession({
    groupId: g.id, name: "task one", task: "t",
    worktreePath: "", branch: "feature/s1", worktree: false, baseBranch: "dev",
  });
  return { id: s.id };
}

test("in-place: finishSession merges into base, restores base, deletes the branch", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "feature.txt"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toEqual({ merged: true, into: "dev" });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // restored to base
  expect(existsSync(join(repo, "feature.txt"))).toBe(true); // work landed on dev
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe(""); // branch deleted
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("merged");
});

test("in-place: conflict leaves markers on the branch; resolve + re-finish merges", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "file.txt"), "session\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "session edit");
  });
  // Diverge base on the same file.
  git(repo, "checkout", "-q", "dev");
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");
  git(repo, "checkout", "-q", "feature/s1"); // in-place sits on the session branch

  const first = await sup.finishSession(id);
  expect("conflict" in first).toBe(true);
  expect(git(repo, "branch", "--show-current").trim()).toBe("feature/s1"); // still on the branch
  expect(await wt.unmergedFiles(repo)).toContain("file.txt");
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("conflict");

  // Resolve on the branch + complete the merge (as the agent/user would).
  writeFileSync(join(repo, "file.txt"), "resolved\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--no-edit");

  const second = await sup.finishSession(id);
  expect(second).toMatchObject({ merged: true, into: "dev" });
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("resolved");
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe("");
});

test("in-place: finishInfo reports base as target, ahead, dirty", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "c1");
    writeFileSync(join(repo, "b.txt"), "2\n"); // uncommitted
  });

  expect(await sup.finishInfo(id)).toMatchObject({
    branch: "feature/s1", target: "dev", ahead: 1, dirty: true,
  });
});

test("in-place: deleteSession restores base and removes the branch", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "x.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "x");
  });

  await sup.deleteSession(id);

  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe("");
  expect(reg.listSessions().find((x) => x.id === id)).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/finish.spec.ts`
Expected: FAIL — in-place branches throw "session has no worktree" / wrong target.

- [ ] **Step 3: Implement the in-place branches**

`finishInfo` (replace body, 262-272) — branch on `s.worktree`:

```ts
  async finishInfo(id: string): Promise<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
    const target = s.worktree ? await this.worktree.currentBranch(g.projectDir) : (s.baseBranch ?? "");
    const ahead = target ? await this.worktree.aheadCount(g.projectDir, target, s.branch) : 0;
    const dirty = await this.worktree.hasUncommitted(dir);
    const conflicts = await this.worktree.unmergedFiles(dir);
    return { branch: s.branch, target, ahead, dirty, conflicts };
  }
```

`finishSession` (replace body, 278-316) — keep the worktree path, add the in-place path:

```ts
  async finishSession(id: string): Promise<{ merged: true; into: string } | { conflict: true; files: string[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");

    if (s.worktree) {
      if (!s.worktreePath) throw new Error("session has no worktree");
      const target = await this.worktree.currentBranch(g.projectDir);
      if (!target) throw new Error("project repo has a detached HEAD - checkout a branch first");
      if (target === s.branch) throw new Error("project repo is on the session branch itself");
      if ((await this.worktree.unmergedFiles(s.worktreePath)).length)
        throw new Error("worktree has unresolved conflicts - resolve them in the editor first");
      if (await this.worktree.hasUncommitted(s.worktreePath))
        await this.worktree.commitAll(s.worktreePath, `session work: ${s.name}`);
      const res = await this.worktree.mergeBranch(g.projectDir, s.branch, `merge session: ${s.name}`);
      if (!res.ok) {
        if (!res.conflict) throw new Error(res.message);
        await this.worktree.mergeInto(s.worktreePath, target);
        this.registry.updateSession(id, { status: "conflict" });
        this.pushUpdate(id);
        return { conflict: true, files: await this.worktree.unmergedFiles(s.worktreePath) };
      }
      const l = this.map.get(id);
      if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
      await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
      await this.worktree.removeBranch(g.projectDir, s.branch);
      this.registry.updateSession(id, { status: "merged", worktreePath: "" });
      this.pushUpdate(id);
      return { merged: true, into: target };
    }

    // In-place: projectDir is checked out on the session branch. Merge it into base.
    const base = s.baseBranch;
    if (!base) throw new Error("in-place session has no base branch");
    const cur = await this.worktree.currentBranch(g.projectDir);
    if (cur !== s.branch)
      throw new Error(`project is not on ${s.branch} (on ${cur || "detached HEAD"}) - switch to it first`);
    if ((await this.worktree.unmergedFiles(g.projectDir)).length)
      throw new Error("project has unresolved conflicts - resolve them first");
    if (await this.worktree.hasUncommitted(g.projectDir))
      await this.worktree.commitAll(g.projectDir, `session work: ${s.name}`);

    await this.worktree.checkout(g.projectDir, base);
    const res = await this.worktree.mergeBranch(g.projectDir, s.branch, `merge session: ${s.name}`);
    if (!res.ok) {
      // Restore onto the session branch; on a content conflict leave markers there to resolve.
      await this.worktree.checkout(g.projectDir, s.branch);
      if (!res.conflict) throw new Error(res.message);
      await this.worktree.mergeInto(g.projectDir, base);
      this.registry.updateSession(id, { status: "conflict" });
      this.pushUpdate(id);
      return { conflict: true, files: await this.worktree.unmergedFiles(g.projectDir) };
    }
    const l = this.map.get(id);
    if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
    await this.worktree.removeBranch(g.projectDir, s.branch); // projectDir left on base
    this.registry.updateSession(id, { status: "merged" });
    this.pushUpdate(id);
    return { merged: true, into: base };
  }
```

`deleteSession` (replace the group block, 237-243):

```ts
    if (s) {
      const g = this.registry.listGroups().find((x) => x.id === s.groupId);
      if (g) {
        if (s.worktree) {
          if (s.worktreePath) await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
        } else if (s.baseBranch && (await this.worktree.currentBranch(g.projectDir)) === s.branch) {
          // Restore the project to its base branch (delete discards the session's in-progress work).
          await this.worktree
            .checkout(g.projectDir, s.baseBranch)
            .catch(() => this.worktree.checkout(g.projectDir, s.baseBranch!, { force: true }));
        }
        await this.worktree.removeBranch(g.projectDir, s.branch);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/finish.spec.ts`
Expected: PASS — the 5 original worktree tests plus the 4 new in-place tests.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/finish.spec.ts
git commit -m "feat(api): in-place finish/finishInfo/delete for non-worktree sessions"
```

---

### Task 6: Supervisor + Preview — `sessionDir` for preview / editor / resolve / resume

**Files:**
- Modify: `kermanych/apps/api/src/preview/preview.service.ts:29-35,42,55` (`start`)
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` — `resolveConflict` (201-215), `openInEditor` (319-327), `doResume` (366-391)
- Test: `kermanych/apps/api/test/preview.spec.ts` (extend)

**Interfaces:**
- Consumes: `Session.worktree`/`worktreePath`, `Group.projectDir`.
- Produces (behavior): all four paths anchor at `worktreePath || group.projectDir`. `doResume` additionally refuses to resume an in-place session when the project dir is no longer on the session branch.

- [ ] **Step 1: Write the failing test**

Append to `preview.spec.ts` (extend the stub to carry `projectDir` and support an in-place session with empty `worktreePath`):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("in-place preview falls back to the group project dir when worktreePath is empty", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "kmq-prev-"));
  const stub = {
    listSessions: () => [{ id: "s1", groupId: "g1", worktreePath: "", worktree: false }],
    listGroups: () => [{ id: "g1", projectDir, previewCommand: httpEcho("'ok'") }],
  } as unknown as RegistryService;
  svc = new PreviewService(stub);
  const res = await svc.start("s1");
  if (!("url" in res)) throw new Error("expected a preview url");
  const port = Number(new URL(res.url).port);
  expect(await canConnect(port)).toBe(true);
  svc.stop("s1");
  rmSync(projectDir, { recursive: true, force: true });
}, 30_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/preview.spec.ts`
Expected: FAIL — `start` throws "session has no worktree" (empty `worktreePath`).

- [ ] **Step 3: Implement the anchor changes**

`preview.service.ts` `start` — replace the guard (32-35) and use `dir` for both spawns (42, 55):

```ts
    const s = this.registry.listSessions().find((x) => x.id === sessionId);
    if (!s) throw new Error("session not found");
    const group = this.registry.listGroups().find((g) => g.id === s.groupId);
    if (!group) throw new Error("group not found");
    const dir = s.worktreePath || group.projectDir;
    if (!group.previewCommand) return { needsCommand: true };
```

Then change `s.worktreePath` → `dir` in the two `this.spawnCmd(..., s.worktreePath, ...)` calls.

`supervisor.service.ts` `resolveConflict` (201-215) — anchor via project dir:

```ts
  async resolveConflict(id: string): Promise<{ ok: true }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
    const files = await this.worktree.unmergedFiles(dir);
    if (!files.length) throw new Error("no merge conflict to resolve");
    const prompt =
      `A git merge is in progress in this worktree with conflicts in:\n` +
      files.map((f) => `- ${f}`).join("\n") +
      `\n\nResolve every conflict: edit each file, remove the conflict markers ` +
      `(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ` +
      `branch's changes AND the changes merged in from the base branch. When all conflicts ` +
      `are resolved, run \`git add -A && git commit --no-edit\` to complete the merge. Do only this.`;
    await this.sendMessage(id, prompt, "prompt");
    return { ok: true };
  }
```

`openInEditor` (319-327) — open the anchor dir:

```ts
  openInEditor(id: string): { ok: true } {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
    const editor = process.env.KERMANYCH_EDITOR || "code";
    const child = spawn(editor, [dir], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  }
```

`doResume` (366-391) — anchor + in-place branch guard. Replace the top of the method:

```ts
  private async doResume(id: string): Promise<Live> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
    if (!s.worktree && (await this.worktree.currentBranch(g.projectDir)) !== s.branch)
      throw new Error(`project is not on ${s.branch} — switch to it or delete the agent`);
    const rpc = new RpcSession({ cwd: dir });
    // ...unchanged from here: wireLive, rpc.start(), switchSession, transcript, etc.
```

(Leave the rest of `doResume` — `wireLive`/`start`/`switchSession`/error handling — unchanged; only the anchor + guard at the top change. `s.worktreePath` on line 369-370 is replaced by the `dir` computed above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run test/preview.spec.ts`
Expected: PASS (existing 3 + new fallback test). Then full api suite: `cd kermanych && pnpm --filter @kermanych/api exec vitest run`.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/preview/preview.service.ts kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/preview.spec.ts
git commit -m "feat(api): anchor preview/editor/resolve/resume at worktreePath||projectDir"
```

---

### Task 7: API controller + UI transport plumbing

**Files:**
- Modify: `kermanych/apps/api/src/http/sessions.controller.ts:21-28` (`create`)
- Modify: `kermanych/apps/ui/src/lib/api.ts:64-71` (`createSession`)
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts:87-95` (`createSession`)

**Interfaces:**
- Consumes: `SupervisorService.createSession(..., worktree?, prefix?)` (Task 4); `BranchPrefix` (type-only in UI).
- Produces: `POST /sessions` accepts `{ ..., worktree?: boolean, prefix?: BranchPrefix }`; UI `api.createSession(groupId, name, task, model?, images?, worktree?, prefix?)` and the store wrapper forward them.

- [ ] **Step 1: Update the controller**

`sessions.controller.ts` `create`:

```ts
  @Post()
  async create(
    @Body()
    b: { groupId: string; name: string; task: string; model?: string; images?: ImageInput[]; worktree?: boolean; prefix?: BranchPrefix },
  ) {
    try {
      return await this.sup.createSession(b.groupId, b.name, b.task, b.model, b.images, b.worktree ?? true, b.prefix ?? "feature");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
```

Add `BranchPrefix` to the `@kermanych/core` type import on line 3:
`import type { BranchPrefix, ImageInput, RpcExtensionUIResponse } from "@kermanych/core";`

- [ ] **Step 2: Update the UI transport**

`apps/ui/src/lib/api.ts` — add the type-only import at the top type block (line 3-10) and extend `createSession`:

```ts
import type {
  BranchPrefix,
  DirListing,
  ImageInput,
  Group,
  Session,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';
```

```ts
  createSession: (
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
  ): Promise<Session> =>
    post<Session>('/sessions', { groupId, name, task, model, images, worktree, prefix }),
```

`apps/ui/src/stores/orchestrator.ts` — extend the wrapper (87-95). Add `BranchPrefix` to its type-only import (line 5-12) and:

```ts
  function createSession(
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
  ) {
    return api.createSession(groupId, name, task, model, images, worktree, prefix);
  }
```

- [ ] **Step 3: Typecheck / build the API**

Run: `cd kermanych && pnpm --filter @kermanych/api build`
Expected: builds clean (nest build typechecks the controller change).

- [ ] **Step 4: Run the api test suite (no regressions)**

Run: `cd kermanych && pnpm --filter @kermanych/api exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/http/sessions.controller.ts kermanych/apps/ui/src/lib/api.ts kermanych/apps/ui/src/stores/orchestrator.ts
git commit -m "feat: thread worktree flag + branch prefix through the create API"
```

---

### Task 8: UI — KCheckbox + launcher controls

**Files:**
- Create: `kermanych/apps/ui/src/components/kit/KCheckbox.vue`
- Modify: `kermanych/apps/ui/src/pages/WorkspacePage.vue` (launcher template ~150-158; script ~251-253 imports, ~350-388 state + `openLauncher`; `submitLauncher` ~390-402)

**Interfaces:**
- Consumes: `store.createSession(..., worktree, prefix)` (Task 7); `type BranchPrefix` (type-only).
- Produces: `KCheckbox` presenter (`modelValue?: boolean`, `label?: string`, `disabled?: boolean`; emits `update:modelValue: boolean`). Launcher passes `draftWorktree`/`draftPrefix` into `store.createSession`.

- [ ] **Step 1: Create the KCheckbox component**

`kermanych/apps/ui/src/components/kit/KCheckbox.vue`:

```vue
<template>
  <label class="k-checkbox">
    <input
      class="k-checkbox__box"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <span v-if="label" class="k-checkbox__label">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
// Checkbox: token-styled native input, radius 0, accent fill when checked.
defineProps<{ modelValue?: boolean; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked);
}
</script>

<style scoped lang="scss">
.k-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--k-font-ui);
  font-size: 13px;
  color: var(--k-text);
  cursor: pointer;
  user-select: none;
}
.k-checkbox__box {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid var(--k-line-strong);
  background: var(--k-surface);
  border-radius: 0;
  display: grid;
  place-content: center;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.k-checkbox__box:checked {
  background: var(--k-accent);
  border-color: var(--k-accent);
}
.k-checkbox__box:checked::after {
  content: '';
  width: 4px;
  height: 8px;
  border: solid var(--k-canvas);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}
.k-checkbox__box:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
```

- [ ] **Step 2: Wire launcher template**

In `WorkspacePage.vue`, insert after the `launchError` `<p>` (line 152), before the model `KField` (153):

```html
        <label class="ws__field">
          <span class="ws__field-label">Префікс гілки</span>
          <KToggle
            :options="prefixOptions"
            :modelValue="draftPrefix"
            @update:modelValue="(v) => (draftPrefix = v as BranchPrefix)"
          />
        </label>
        <div class="ws__field">
          <KCheckbox v-model="draftWorktree" label="Ізолювати у worktree" />
          <p v-if="!draftWorktree" class="ws__hint mono">
            In-place: агент працюватиме в теці проєкту на гілці
            <code class="mono">{{ branchPreview }}</code>. Дерево має бути чистим;
            одночасно лише один in-place-агент.
          </p>
        </div>
```

- [ ] **Step 3: Wire launcher script**

Add imports near the other kit imports (line 251-253):

```ts
import KCheckbox from 'components/kit/KCheckbox.vue';
import type { BranchPrefix } from '@kermanych/core';
```

Add state next to the other `draft*` refs (line 350-353). The prefix list is a UI display concern mirroring core `BRANCH_PREFIXES` (imported type-only above to avoid pulling Node built-ins into the bundle); `slugify` is inlined for the preview only:

```ts
const prefixOptions: BranchPrefix[] = ['feature', 'fix', 'refactoring', 'chore'];
const draftPrefix = ref<BranchPrefix>('feature');
const draftWorktree = ref(true);
const branchPreview = computed(() => {
  const slug =
    draftName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  return `${draftPrefix.value}/${slug}`;
});
```

Reset them in `openLauncher` (after line 383, `draftModel.value = ''`):

```ts
  draftPrefix.value = 'feature';
  draftWorktree.value = true;
```

Pass them in `submitLauncher` (the `store.createSession(...)` call, 396-402):

```ts
    const session = await store.createSession(
      groupId,
      draftName.value.trim(),
      draftTask.value.trim(),
      model,
      launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType })),
      draftWorktree.value,
      draftPrefix.value,
    );
```

- [ ] **Step 4: Smoke test in the browser**

Run both dev servers (`cd kermanych && pnpm dev:api` and `pnpm dev:ui`), open <http://localhost:5317>, select a project group, click **+ Новий агент**:
- Default (checkbox ✔) → launches in a worktree; the agent row's **Гілка** tag shows `feature/<slug>`; switching the prefix toggle changes the tag on the next launch.
- Uncheck **Ізолювати у worktree** on a clean project → the hint shows `<prefix>/<slug>`; launch → `git -C <projectDir> branch --show-current` reports `<prefix>/<slug>`; **Завершити** merges into the base branch and restores it; editor/preview open the project dir.
- Uncheck on a dirty project → the launcher stays open with the server error ("project working tree must be clean…"); nothing is created.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KCheckbox.vue kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): worktree toggle + branch prefix in the new-agent launcher"
```

---

## Self-Review

**Spec coverage:**
- §3.1 prefix + de-dup on full branch names → Task 1 (naming) + Task 4 (`uniqueSlug` over full branch set).
- §3.2 data model (`worktree`, `baseBranch`, migrations) → Tasks 1 + 2.
- §3.3 API surface (`POST /sessions`, supervisor signature, UI transport) → Tasks 4 + 7.
- §3.4 worktree primitives (`checkout`, `createBranchHere`) → Task 3.
- §3.5 lifecycle (`sessionDir`, create/finish/finishInfo/delete/resume/preview/editor/resolve) → Tasks 4, 5, 6.
- §3.6 UI (prefix toggle, `KCheckbox`, hint, wiring) → Task 8.
- §5 verification (naming/dedup/registry units, in-place finish + conflict, guards, preview fallback, smoke) → Tasks 1-6, 8.

**Placeholder scan:** none — every step carries real code or an exact command.

**Type consistency:** `worktree: boolean` / `baseBranch?: string` (Tasks 1-2) used identically in Tasks 4-8; `checkout(dir, ref, {force?})` and `createBranchHere(dir, branch)` (Task 3) called with matching signatures in Tasks 4-6; `createSession(..., worktree?, prefix?)` positional order identical in supervisor (4), controller/api/store (7), launcher (8); `BranchPrefix` imported type-only in every UI file.

**Note on de-dup:** `uniqueSlug(base, existing)` (unchanged) is reused over full branch strings — `feature/x` collides → `feature/x-2`; different prefixes never collide because the full string differs. No new helper needed.
