# Per-project environment for sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every worktree session the project's gitignored secret files (`.env`), and let users configure those secrets in-app by editing the project's `.env` through a Project Settings panel.

**Architecture:** Model W — the project's `.env` on disk stays the single source of truth. The API (a) copies each declared `carryFiles` entry from `projectDir` into a session worktree at creation, and (b) exposes read/write of `projectDir/.env` via an `EnvFileService` that does surgical, atomic, path-confined edits. Kermanych stores no secret VALUES; only the per-group `carryFiles` list lives in SQLite.

**Tech Stack:** NestJS (api), Quasar/Vue 3 + Pinia (ui), `@kermanych/core` (shared types), `better-sqlite3`, vitest.

## Global Constraints

- Node 22.x required (`better-sqlite3` native ABI).
- Code/identifiers/commits in English; UI-visible strings in Ukrainian.
- Follow existing patterns: additive guarded `ALTER TABLE … ADD COLUMN` migrations; `K*` kit components for UI; services shell `git` via child_process.
- Kermanych stores NO secret values in its DB — `.env` is canonical.
- All env-file writes MUST be path-confined to `projectDir` (reject `..`/absolute escapes) and atomic (temp file + `rename`).
- Do not auto-edit `.gitignore` (warn only).
- vitest only runs for `apps/api` and `packages/core`; the `ui` package has no component-test harness, so UI tasks are verified by running the app.

---

### Task 1: Shared types (`Group.carryFiles`, env view contract)

**Files:**
- Modify: `packages/core/src/types.ts:7`

**Interfaces:**
- Produces: `Group.carryFiles?: string[]`; `EnvEntry = { key: string; value: string }`; `EnvFileView = { entries: EnvEntry[]; ignored: boolean }`.

- [ ] **Step 1: Add the fields**

Replace the `Group` type (line 7) and add the env-view types after it:

```ts
export type Group = { id: string; name: string; projectDir: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; createdAt: string };

export type EnvEntry = { key: string; value: string };
export type EnvFileView = { entries: EnvEntry[]; ignored: boolean };
```

`carryFiles` is optional in the type (existing `createGroup({name, projectDir})` callers stay valid); the registry always returns it populated at runtime.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @kermanych/core build` (or `pnpm -w exec tsc -p packages/core/tsconfig.json --noEmit`)
Expected: no type errors. `EnvEntry`/`EnvFileView`/`Group` are re-exported via `packages/core/src/index.ts` (`export * from "./types"`).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add Group.carryFiles and env-file view types"
```

---

### Task 2: Registry — persist `carryFiles`

**Files:**
- Modify: `apps/api/src/registry/registry.service.ts` (constructor migration ~line 34; `listGroups` 62-68; `createGroup` 70-76; `updateGroup` 78-86)
- Test: `apps/api/test/registry.spec.ts`

**Interfaces:**
- Consumes: `Group.carryFiles` (Task 1).
- Produces: `createGroup(g)` writes/returns `carryFiles` (default `[".env"]`); `listGroups()` returns parsed `carryFiles`; `updateGroup(id, { previewCommand?, apiCommand?, carryFiles? })` persists it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/registry.spec.ts`:

```ts
test("group carryFiles defaults to [.env] and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(g.carryFiles).toEqual([".env"]);
  expect(r.listGroups()[0].carryFiles).toEqual([".env"]);

  const withList = r.createGroup({ name: "b", projectDir: "/tmp/b", carryFiles: [".env", ".env.local"] });
  expect(r.listGroups().find((x) => x.id === withList.id)!.carryFiles).toEqual([".env", ".env.local"]);

  const u = r.updateGroup(g.id, { carryFiles: [".env", "config/svc.json"] });
  expect(u.carryFiles).toEqual([".env", "config/svc.json"]);
  expect(r.listGroups().find((x) => x.id === g.id)!.carryFiles).toEqual([".env", "config/svc.json"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts -t carryFiles`
Expected: FAIL (column/field missing).

- [ ] **Step 3: Add the migration**

In the constructor, after the archived/last-activity/worktree migrations (after line 59, before the closing `}`), add:

```ts
    // Additive migration: per-project carry-files list arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE groups ADD COLUMN carry_files TEXT NOT NULL DEFAULT '[".env"]'`);
    } catch {
      /* column already exists */
    }
```

- [ ] **Step 4: Parse `carryFiles` in `listGroups`**

Replace `listGroups` (62-68):

```ts
  listGroups(): Group[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, project_dir as projectDir, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, created_at as createdAt FROM groups ORDER BY created_at`,
      )
      .all() as (Omit<Group, "carryFiles"> & { carryFiles: string })[];
    return rows.map((r) => ({ ...r, carryFiles: JSON.parse(r.carryFiles) as string[] }));
  }
```

- [ ] **Step 5: Persist in `createGroup` and `updateGroup`**

Replace `createGroup` (70-76):

```ts
  createGroup(g: Omit<Group, "id" | "createdAt">): Group {
    const carryFiles = g.carryFiles ?? [".env"];
    const row: Group = { ...g, carryFiles, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO groups (id, name, project_dir, carry_files, created_at) VALUES (?,?,?,?,?)`)
      .run(row.id, row.name, row.projectDir, JSON.stringify(carryFiles), row.createdAt);
    return row;
  }
```

Replace `updateGroup` (78-86):

```ts
  updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] }): Group {
    const cur = this.listGroups().find((g) => g.id === id);
    if (!cur) throw new Error("group not found");
    const next = { ...cur, ...patch };
    this.db
      .prepare(`UPDATE groups SET preview_command=?, api_command=?, carry_files=? WHERE id=?`)
      .run(next.previewCommand ?? null, next.apiCommand ?? null, JSON.stringify(next.carryFiles ?? [".env"]), id);
    return next;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts`
Expected: PASS (new test + existing group/session round-trips).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/registry/registry.service.ts apps/api/test/registry.spec.ts
git commit -m "feat(api): persist per-group carryFiles in the registry"
```

---

### Task 3: Pure env-text functions (parse / apply / serialize)

**Files:**
- Create: `apps/api/src/env/env-text.ts`
- Test: `apps/api/test/env-text.spec.ts`

**Interfaces:**
- Produces: `parseEnv(text: string): EnvEntry[]`; `applyEnvEdits(text: string, edits: { set?: Record<string,string>; remove?: string[] }): string`. Values are single-line (the UI has single-line inputs); inline comments after a value are not stripped in v1.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/env-text.spec.ts`:

```ts
import { expect, test } from "vitest";
import { parseEnv, applyEnvEdits } from "../src/env/env-text";

test("parseEnv reads KEY=value, skips comments/blank/invalid, unquotes", () => {
  const text = `# comment\n\nA=1\nB="two words"\nGITHUB_TOKEN=ghp_x\nnot a var\n123=bad\n`;
  expect(parseEnv(text)).toEqual([
    { key: "A", value: "1" },
    { key: "B", value: "two words" },
    { key: "GITHUB_TOKEN", value: "ghp_x" },
  ]);
});

test("applyEnvEdits updates in place preserving comments/order", () => {
  const text = `# top\nA=1\nB=2\n`;
  expect(applyEnvEdits(text, { set: { B: "9" } })).toBe(`# top\nA=1\nB=9\n`);
});

test("applyEnvEdits appends new keys and removes requested keys", () => {
  const text = `A=1\nB=2\n`;
  expect(applyEnvEdits(text, { set: { C: "3" }, remove: ["A"] })).toBe(`B=2\nC=3\n`);
});

test("applyEnvEdits quotes values with whitespace or shell specials", () => {
  expect(applyEnvEdits("", { set: { U: "a b", Q: "x&y" } })).toBe(`U="a b"\nQ="x&y"\n`);
});

test("applyEnvEdits escapes embedded quote/backslash", () => {
  expect(applyEnvEdits("", { set: { P: 'a"b\\c' } })).toBe(`P="a\\"b\\\\c"\n`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/env-text.spec.ts`
Expected: FAIL ("Cannot find module '../src/env/env-text'").

- [ ] **Step 3: Implement**

Create `apps/api/src/env/env-text.ts`:

```ts
// apps/api/src/env/env-text.ts
// Pure, dependency-free .env text helpers. Values are single-line; inline
// comments after a value are treated as part of the value (v1 simplification).
import type { EnvEntry } from "@kermanych/core";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") {
    return v.slice(1, -1);
  }
  return v;
}

function needsQuote(v: string): boolean {
  return v === "" || /[\s"'`$&|;<>()#\\]/.test(v);
}

function serializeValue(v: string): string {
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function keyOf(line: string): string | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  if (line.trim().startsWith("#")) return null;
  const key = line.slice(0, eq).trim();
  return KEY_RE.test(key) ? key : null;
}

export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const key = keyOf(line);
    if (!key) continue;
    const value = unquote(line.slice(line.indexOf("=") + 1).trim());
    out.push({ key, value });
  }
  return out;
}

export function applyEnvEdits(
  text: string,
  edits: { set?: Record<string, string>; remove?: string[] },
): string {
  const set = edits.set ?? {};
  const remove = new Set(edits.remove ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text ? text.split(/\r?\n/) : []) {
    const key = keyOf(line);
    if (key && remove.has(key)) continue;
    if (key && key in set) {
      out.push(`${key}=${serializeValue(set[key])}`);
      seen.add(key);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  for (const [k, v] of Object.entries(set)) {
    if (!seen.has(k)) out.push(`${k}=${serializeValue(v)}`);
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/env-text.spec.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/env/env-text.ts apps/api/test/env-text.spec.ts
git commit -m "feat(api): pure .env parse/apply/serialize helpers"
```

---

### Task 4: `EnvFileService` (read/write, path guard, atomic, ignored)

**Files:**
- Create: `apps/api/src/env/env-file.service.ts`
- Modify: `apps/api/src/worktree/worktree.service.ts` (add `isIgnored`)
- Test: `apps/api/test/env-file.spec.ts`

**Interfaces:**
- Consumes: `parseEnv`/`applyEnvEdits` (Task 3); `WorktreeService.isIgnored` (added here).
- Produces:
  - `WorktreeService.isIgnored(dir: string, path: string): Promise<boolean>`
  - `EnvFileService.read(projectDir: string, file?: string): Promise<EnvFileView>`
  - `EnvFileService.write(projectDir: string, file: string | undefined, edits: { set?: Record<string,string>; remove?: string[] }): Promise<EnvFileView>`

- [ ] **Step 1: Add `isIgnored` to WorktreeService**

In `apps/api/src/worktree/worktree.service.ts`, add a method (after `unmergedFiles`, before the closing brace ~line 96):

```ts
  // True when `path` is git-ignored in `dir` (exit 0 from check-ignore). Works
  // on non-existent paths too, so it can validate a file we are about to create.
  async isIgnored(dir: string, path: string): Promise<boolean> {
    return (await git(dir, ["check-ignore", "-q", "--", path])).ok;
  }
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/env-file.spec.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";
import { EnvFileService } from "../src/env/env-file.service";

const wt = new WorktreeService();
const svc = new EnvFileService(wt);
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-env-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".env\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("read reports entries and ignored flag", async () => {
  writeFileSync(join(repo, ".env"), "# c\nA=1\nGITHUB_TOKEN=ghp_x\n");
  const view = await svc.read(repo);
  expect(view.entries).toEqual([{ key: "A", value: "1" }, { key: "GITHUB_TOKEN", value: "ghp_x" }]);
  expect(view.ignored).toBe(true);
});

test("read of a missing .env returns empty entries", async () => {
  const view = await svc.read(repo);
  expect(view.entries).toEqual([]);
});

test("write updates in place, appends, removes, and preserves comments", async () => {
  writeFileSync(join(repo, ".env"), "# keep\nA=1\nB=2\n");
  await svc.write(repo, ".env", { set: { B: "9", C: "3" }, remove: ["A"] });
  expect(readFileSync(join(repo, ".env"), "utf8")).toBe("# keep\nB=9\nC=3\n");
});

test("write creates the file when absent", async () => {
  await svc.write(repo, ".env", { set: { GITHUB_TOKEN: "ghp_new" } });
  expect(readFileSync(join(repo, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_new\n");
});

test("write rejects paths escaping the project dir", async () => {
  await expect(svc.write(repo, "../evil", { set: { X: "1" } })).rejects.toThrow(/escapes/i);
  await expect(svc.write(repo, "/etc/passwd", { set: { X: "1" } })).rejects.toThrow(/escapes/i);
});

test("read warns (ignored=false) when .env is not gitignored", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules\n"); // no .env
  writeFileSync(join(repo, ".env"), "A=1\n");
  expect((await svc.read(repo)).ignored).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/env-file.spec.ts`
Expected: FAIL ("Cannot find module '../src/env/env-file.service'").

- [ ] **Step 4: Implement the service**

Create `apps/api/src/env/env-file.service.ts`:

```ts
// apps/api/src/env/env-file.service.ts
import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { EnvFileView } from "@kermanych/core";
import { WorktreeService } from "../worktree/worktree.service";
import { parseEnv, applyEnvEdits } from "./env-text";

@Injectable()
export class EnvFileService {
  constructor(private worktree: WorktreeService) {}

  // Resolve `<projectDir>/<file>` and refuse anything that escapes projectDir.
  private target(projectDir: string, file: string): string {
    const base = resolve(projectDir);
    const target = resolve(projectDir, file);
    if (!target.startsWith(base + sep)) throw new Error(`path escapes project directory: ${file}`);
    return target;
  }

  async read(projectDir: string, file = ".env"): Promise<EnvFileView> {
    const target = this.target(projectDir, file);
    const text = existsSync(target) ? await readFile(target, "utf8") : "";
    const ignored = await this.worktree.isIgnored(projectDir, file);
    return { entries: parseEnv(text), ignored };
  }

  async write(
    projectDir: string,
    file = ".env",
    edits: { set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> {
    const target = this.target(projectDir, file);
    const current = existsSync(target) ? await readFile(target, "utf8") : "";
    const next = applyEnvEdits(current, edits);
    const tmp = `${target}.kmq-${process.pid}.tmp`;
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, target); // atomic on the same filesystem
    return this.read(projectDir, file);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/env-file.spec.ts test/worktree.spec.ts`
Expected: PASS (env-file suite + unchanged worktree suite).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/env/env-file.service.ts apps/api/src/worktree/worktree.service.ts apps/api/test/env-file.spec.ts
git commit -m "feat(api): EnvFileService with atomic, path-confined .env edits"
```

---

### Task 5: Copy carry-files into the worktree at session creation

**Files:**
- Create: `apps/api/src/env/carry-files.ts`
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (imports 1-26; `addGroup` 66-71; `updateGroup` 77-81; `createSession` 114-129)
- Test: `apps/api/test/carry-files.spec.ts`

**Interfaces:**
- Consumes: `Group.carryFiles` (Task 1/2).
- Produces: `copyCarryFiles(projectDir: string, wtDir: string, files: string[]): Promise<void>`; `SupervisorService.addGroup(name, projectDir, carryFiles?)`; `SupervisorService.updateGroup(id, { previewCommand?, apiCommand?, carryFiles? })`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/carry-files.spec.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCarryFiles } from "../src/env/carry-files";

let proj: string;
let wt: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "kmq-carry-proj-"));
  wt = mkdtempSync(join(tmpdir(), "kmq-carry-wt-"));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

test("copies existing files (incl. nested), skips missing", async () => {
  writeFileSync(join(proj, ".env"), "A=1\n");
  mkdirSync(join(proj, "config"));
  writeFileSync(join(proj, "config", "svc.json"), "{}\n");
  await copyCarryFiles(proj, wt, [".env", "config/svc.json", ".env.local"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("A=1\n");
  expect(readFileSync(join(wt, "config", "svc.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(wt, ".env.local"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/carry-files.spec.ts`
Expected: FAIL ("Cannot find module '../src/env/carry-files'").

- [ ] **Step 3: Implement `copyCarryFiles`**

Create `apps/api/src/env/carry-files.ts`:

```ts
// apps/api/src/env/carry-files.ts
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Copy each declared file that exists in projectDir into wtDir at the same
// relative path. Missing entries are skipped (a project may not have `.env`).
export async function copyCarryFiles(projectDir: string, wtDir: string, files: string[]): Promise<void> {
  for (const f of files) {
    const src = join(projectDir, f);
    if (!existsSync(src)) continue;
    const dest = join(wtDir, f);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/carry-files.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the supervisor**

In `apps/api/src/supervisor/supervisor.service.ts`:

Add imports after line 8:

```ts
import { copyCarryFiles } from "../env/carry-files";
```

Replace `addGroup` (66-71):

```ts
  async addGroup(name: string, projectDir: string, carryFiles?: string[]): Promise<Group> {
    if (!(await this.worktree.isGitRepo(projectDir))) throw new Error("project dir is not a git repo");
    const g = this.registry.createGroup({ name, projectDir, carryFiles });
    this.events.next({ type: "group_update", group: g });
    return g;
  }
```

Replace `updateGroup` (77-81):

```ts
  async updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] }): Promise<Group> {
    const g = this.registry.updateGroup(id, patch);
    this.events.next({ type: "group_update", group: g });
    return g;
  }
```

Replace the worktree-creation block in `createSession` (114-126) so the copy runs after `addWorktree` and the catch cleans up a created worktree/branch:

```ts
    let wtDir = "";
    try {
      if (worktree) {
        wtDir = worktreeDir(session.id);
        await this.worktree.addWorktree(group.projectDir, wtDir, branch);
        await copyCarryFiles(group.projectDir, wtDir, group.carryFiles ?? [".env"]);
      } else {
        await this.worktree.createBranchHere(group.projectDir, branch);
      }
    } catch (err) {
      if (wtDir) await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
```

- [ ] **Step 6: Run api tests to verify nothing regressed**

Run: `pnpm --filter @kermanych/api exec vitest run test/carry-files.spec.ts test/create-guards.spec.ts test/finish.spec.ts`
Expected: PASS. (The in-place refusal guards in `create-guards.spec.ts` throw before the worktree block, so the modified catch does not affect them.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/env/carry-files.ts apps/api/src/supervisor/supervisor.service.ts apps/api/test/carry-files.spec.ts
git commit -m "feat(api): copy per-group carryFiles into session worktrees"
```

---

### Task 6: HTTP surface (carryFiles on groups + env endpoints)

**Files:**
- Modify: `apps/api/src/http/groups.controller.ts`
- Modify: `apps/api/src/app.module.ts:13`

**Interfaces:**
- Consumes: `SupervisorService.addGroup/updateGroup` (Task 5), `EnvFileService` (Task 4), `RegistryService.listGroups` (Task 2).
- Produces: `POST /groups {name, projectDir, carryFiles?}`; `PATCH /groups/:id {previewCommand?, apiCommand?, carryFiles?}`; `GET /groups/:id/env?file=` → `EnvFileView`; `PUT /groups/:id/env {file?, set?, remove?}` → `EnvFileView`.

- [ ] **Step 1: Register `EnvFileService` as a provider**

In `apps/api/src/app.module.ts`, import and add to `providers` (line 13):

```ts
import { EnvFileService } from "./env/env-file.service";
```
```ts
  providers: [RegistryService, WorktreeService, SupervisorService, PreviewService, EnvFileService, EventsGateway],
```

- [ ] **Step 2: Extend the groups controller**

Rewrite `apps/api/src/http/groups.controller.ts`:

```ts
// apps/api/src/http/groups.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";
import { EnvFileService } from "../env/env-file.service";

@Controller("groups")
export class GroupsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private env: EnvFileService,
  ) {}

  @Get()
  list() {
    return this.reg.listGroups();
  }

  @Post()
  async create(@Body() b: { name: string; projectDir: string; carryFiles?: string[] }) {
    try {
      return await this.sup.addGroup(b.name, b.projectDir, b.carryFiles);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() b: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] },
  ) {
    try {
      return await this.sup.updateGroup(id, b);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/env")
  async getEnv(@Param("id") id: string, @Query("file") file?: string) {
    const g = this.reg.listGroups().find((x) => x.id === id);
    if (!g) throw new BadRequestException("group not found");
    try {
      return await this.env.read(g.projectDir, file || ".env");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/env")
  async putEnv(
    @Param("id") id: string,
    @Body() b: { file?: string; set?: Record<string, string>; remove?: string[] },
  ) {
    const g = this.reg.listGroups().find((x) => x.id === id);
    if (!g) throw new BadRequestException("group not found");
    try {
      return await this.env.write(g.projectDir, b.file || ".env", { set: b.set, remove: b.remove });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.sup.removeGroup(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }
}
```

- [ ] **Step 3: Verify the api builds and boots**

Run: `pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit`
Expected: no type errors.
Then smoke the routes:
```bash
pnpm dev:api   # in one terminal
# in another:
curl -s -X POST localhost:4317/api/groups -H 'content-type: application/json' \
  -d "{\"name\":\"tmp\",\"projectDir\":\"$(pwd)\"}" | tee /tmp/g.json
ID=$(node -e "console.log(require('/tmp/g.json').id)")
curl -s "localhost:4317/api/groups/$ID/env" ; echo
curl -s -X PUT "localhost:4317/api/groups/$ID/env" -H 'content-type: application/json' \
  -d '{"set":{"KMQ_TEST":"1"}}' ; echo
curl -s -X DELETE "localhost:4317/api/groups/$ID"
```
Expected: create returns a group with `carryFiles:[".env"]`; GET env returns `{entries,ignored}`; PUT env returns the refreshed view including `KMQ_TEST`. (Run against a throwaway dir, then delete the group.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/groups.controller.ts apps/api/src/app.module.ts
git commit -m "feat(api): carryFiles on group routes + GET/PUT /groups/:id/env"
```

---

### Task 7: UI api client (carryFiles + env)

**Files:**
- Modify: `apps/ui/src/lib/api.ts` (imports 3-11; helpers after 56; `createGroup` 59-60; `updateGroup` 94-105)

**Interfaces:**
- Consumes: `EnvEntry`, `EnvFileView`, `Group` (Task 1); routes (Task 6).
- Produces: `api.createGroup(name, projectDir, carryFiles?)`; `api.updateGroup(id, { previewCommand?, apiCommand?, carryFiles? })`; `api.getEnv(id, file?) : Promise<EnvFileView>`; `api.saveEnv(id, { file?, set?, remove? }) : Promise<EnvFileView>`.

- [ ] **Step 1: Import the shared env type**

Add `EnvFileView` to the type import (3-11):

```ts
import type {
  BranchPrefix,
  DirListing,
  ImageInput,
  Group,
  EnvFileView,
  Session,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';
```

- [ ] **Step 2: Add a `put<T>` helper**

After the `get<T>` helper (after line 56):

```ts
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}
```

- [ ] **Step 3: Extend the api object**

Replace `createGroup` (59-60):

```ts
  createGroup: (name: string, projectDir: string, carryFiles?: string[]): Promise<Group> =>
    post<Group>('/groups', { name, projectDir, carryFiles }),
```

Replace the `updateGroup` patch type (96):

```ts
    patch: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] },
```

Add env helpers inside the `api` object (e.g. after `updateGroup`, before `startPreview`):

```ts
  getEnv: (id: string, file?: string): Promise<EnvFileView> =>
    get<EnvFileView>(`/groups/${id}/env${file ? `?file=${encodeURIComponent(file)}` : ''}`),

  saveEnv: (
    id: string,
    patch: { file?: string; set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> => put<EnvFileView>(`/groups/${id}/env`, patch),
```

- [ ] **Step 4: Verify it type-checks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit` (or the ui `lint`/`typecheck` script if present).
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/api.ts
git commit -m "feat(ui): api client for carryFiles and project env"
```

---

### Task 8: UI store actions

**Files:**
- Modify: `apps/ui/src/stores/orchestrator.ts` (`createGroup` 80-82; `updateGroup` 143-145; add `getEnv`/`saveEnv`; return block 182-212)

**Interfaces:**
- Consumes: `api.*` (Task 7).
- Produces: store actions `createGroup(name, projectDir, carryFiles?)`, `updateGroup(id, patch)`, `getEnv(id, file?)`, `saveEnv(id, patch)`.

- [ ] **Step 1: Update `createGroup` and `updateGroup`**

Replace `createGroup` (80-82):

```ts
  function createGroup(name: string, projectDir: string, carryFiles?: string[]) {
    return api.createGroup(name, projectDir, carryFiles);
  }
```

Replace `updateGroup` (143-145):

```ts
  function updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] }) {
    return api.updateGroup(id, patch);
  }
```

- [ ] **Step 2: Add env actions**

After `updateGroup` (after line 145):

```ts
  function getEnv(id: string, file?: string) {
    return api.getEnv(id, file);
  }

  function saveEnv(id: string, patch: { file?: string; set?: Record<string, string>; remove?: string[] }) {
    return api.saveEnv(id, patch);
  }
```

- [ ] **Step 3: Export them**

In the returned object (182-212), add `getEnv,` and `saveEnv,` (next to `updateGroup,`).

- [ ] **Step 4: Verify it type-checks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/stores/orchestrator.ts
git commit -m "feat(ui): store actions for project env + carryFiles"
```

---

### Task 9: `KEnvEditor.vue` — key/value editor with masking

**Files:**
- Create: `apps/ui/src/components/kit/KEnvEditor.vue`
- Modify: `apps/ui/src/components/kit/KField.vue` (add optional `type` prop)

**Interfaces:**
- Consumes: `EnvEntry` (Task 1); `KField`, `KBtn`.
- Produces: `<KEnvEditor :entries :ignored ref="envEditor" />` that exposes `collect(): { set: Record<string,string>; remove: string[] }` via `defineExpose` — computed by diffing the draft against the original `entries` (all current rows become `set`; keys present originally but absent now become `remove`). The parent reads it through a template ref; no event is emitted.

- [ ] **Step 1: Add a `type` prop to KField**

In `apps/ui/src/components/kit/KField.vue`, extend props (16-21) and bind on the input (line 4-10):

```ts
defineProps<{
  label?: string;
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}>();
```
```html
    <input
      class="k-field__input"
      :type="type ?? 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
```

- [ ] **Step 2: Create the editor component**

Create `apps/ui/src/components/kit/KEnvEditor.vue`:

```vue
<template>
  <div class="k-env">
    <p v-if="!ignored" class="k-env__warn" role="alert">
      ⚠ `.env` не в `.gitignore` — його можуть закомітити. Додай `.env` до `.gitignore`.
    </p>
    <p class="k-env__note">
      Значення зберігаються у `.env` проєкту; Керманич їх у себе не тримає. У git файл не потрапляє.
    </p>

    <div v-for="(row, i) in rows" :key="i" class="k-env__row">
      <KField v-model="row.key" placeholder="KEY" />
      <KField v-model="row.value" :type="row.reveal ? 'text' : 'password'" placeholder="value" />
      <KBtn variant="icon" title="Показати/сховати" @click="row.reveal = !row.reveal">
        {{ row.reveal ? '🙈' : '👁' }}
      </KBtn>
      <KBtn variant="icon" title="Видалити" @click="rows.splice(i, 1)">✕</KBtn>
    </div>

    <KBtn variant="secondary" @click="rows.push({ key: '', value: '', reveal: true })">
      Додати змінну
    </KBtn>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { EnvEntry } from '@kermanych/core';
import KField from './KField.vue';
import KBtn from './KBtn.vue';

type Row = { key: string; value: string; reveal: boolean };

const props = defineProps<{ entries: EnvEntry[]; ignored: boolean }>();

const rows = ref<Row[]>([]);

// Re-seed the draft whenever the loaded entries change (e.g. modal re-opened).
watch(
  () => props.entries,
  (entries) => {
    rows.value = entries.map((e) => ({ key: e.key, value: e.value, reveal: false }));
  },
  { immediate: true },
);

function collect(): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  for (const r of rows.value) {
    const key = r.key.trim();
    if (key) set[key] = r.value;
  }
  const originalKeys = props.entries.map((e) => e.key);
  const remove = originalKeys.filter((k) => !(k in set));
  return { set, remove };
}

defineExpose({ collect });
</script>

<style scoped lang="scss">
.k-env { display: flex; flex-direction: column; gap: 10px; }
.k-env__row { display: grid; grid-template-columns: 1fr 1.4fr auto auto; gap: 8px; align-items: end; }
.k-env__note { font-size: 12px; color: var(--k-muted); margin: 0; }
.k-env__warn { font-size: 12px; color: var(--k-accent); margin: 0; }
</style>
```

Note: the parent (Task 10) invokes `collect()` through a template ref + `defineExpose`, so no `save` event is needed. `KBtn variant="icon"` is already used in `MainLayout.vue`, so the variant exists.

- [ ] **Step 3: Verify it type-checks and renders in the kit gallery (optional)**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no type errors. (Optionally drop `<KEnvEditor :entries="[{key:'A',value:'1'}]" :ignored="true" />` into `KitGalleryPage.vue` to eyeball it, then remove.)

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/kit/KEnvEditor.vue apps/ui/src/components/kit/KField.vue
git commit -m "feat(ui): KEnvEditor key/value editor with masking"
```

---

### Task 10: Project Settings modal + gear entry in `MainLayout`

**Files:**
- Modify: `apps/ui/src/layouts/MainLayout.vue` (template header ~40; add settings modal near the add-group modal ~53-75; script 85-167)

**Interfaces:**
- Consumes: `store.getEnv`, `store.saveEnv`, `store.updateGroup` (Task 8); `KEnvEditor` (Task 9); `KModal`, `KBtn`.
- Produces: a gear on the selected-project header that opens a "Налаштування проєкту" modal with the Environment editor (and the `carryFiles` list).

- [ ] **Step 1: Add a gear affordance to the header**

In the header (line 40 area), place a gear button next to the context label, visible only when a project is selected:

```html
      <div class="shell__context mono">{{ contextLabel }}</div>
      <KBtn
        v-if="selectedGroup"
        variant="icon"
        class="shell__settings"
        title="Налаштування проєкту"
        @click="openSettings"
      >⚙</KBtn>
```

- [ ] **Step 2: Add the settings modal to the template**

After the ADD-GROUP `KModal` (after line 75):

```html
    <!-- PROJECT SETTINGS MODAL -->
    <KModal v-model="settingsOpen" :title="`Налаштування · ${selectedGroup?.name ?? ''}`">
      <div class="shell__form">
        <KEnvEditor
          ref="envEditor"
          :entries="envView.entries"
          :ignored="envView.ignored"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (по одному на рядок)"
          placeholder=".env"
        />
        <p v-if="settingsError" class="shell__error" role="alert">{{ settingsError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="settingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" @click="saveSettings">Зберегти</KBtn>
      </template>
    </KModal>
```

- [ ] **Step 3: Wire the script**

Add imports (after line 95): `import KEnvEditor from 'components/kit/KEnvEditor.vue';` and add `EnvFileView` to the core type import.

Add state + handlers (after `submitGroup`, ~line 167):

```ts
const settingsOpen = ref(false);
const settingsError = ref<string | null>(null);
const envView = ref<EnvFileView>({ entries: [], ignored: true });
const carryFilesText = ref('.env');
const envEditor = ref<{ collect: () => { set: Record<string, string>; remove: string[] } } | null>(null);

async function openSettings(): Promise<void> {
  const g = selectedGroup.value;
  if (!g) return;
  settingsError.value = null;
  carryFilesText.value = (g.carryFiles ?? ['.env']).join('\n');
  envView.value = { entries: [], ignored: true };
  settingsOpen.value = true;
  try {
    envView.value = await store.getEnv(g.id);
  } catch (e) {
    settingsError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveSettings(): Promise<void> {
  const g = selectedGroup.value;
  if (!g) return;
  settingsError.value = null;
  try {
    const carryFiles = carryFilesText.value.split('\n').map((s) => s.trim()).filter(Boolean);
    await store.updateGroup(g.id, { carryFiles: carryFiles.length ? carryFiles : ['.env'] });
    const edits = envEditor.value?.collect();
    if (edits && (Object.keys(edits.set).length || edits.remove.length)) {
      await store.saveEnv(g.id, edits);
    }
    settingsOpen.value = false;
  } catch (e) {
    settingsError.value = e instanceof Error ? e.message : String(e);
  }
}
```

- [ ] **Step 4: Verify end to end in the browser**

Run `pnpm dev:api` and `pnpm dev:ui`; open the board. With a project selected, click ⚙:
- the modal loads the project's `.env` keys (values masked; reveal toggles);
- add a variable, Save → reopen → it persists (confirm the real `projectDir/.env` gained the line, comments intact);
- edit `carryFiles`, Save → reopen → the textarea reflects the change.
Expected: all of the above; no console errors.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue
git commit -m "feat(ui): project settings modal with env editor and carryFiles"
```

---

### Task 11: End-to-end smoke against a real repo

**Files:** none (manual verification).

- [ ] **Step 1: Connect a real project**

Run `pnpm dev:api` + `pnpm dev:ui`. Add a project pointing at a real repo (e.g. `platinum-os`). Confirm the created group has `carryFiles: [".env"]`.

- [ ] **Step 2: Configure env in-app**

Open ⚙ → Environment: the repo's existing `.env` keys are listed (masked). Add `KMQ_TEST=1`, Save. Confirm `platinum-os/.env` now contains `KMQ_TEST=1` with all other vars and comments intact (`git -C <repo> diff --stat` shows only `.env`, which is gitignored so it should NOT appear — verify via direct file read).

- [ ] **Step 3: Create a worktree session and verify carry**

Create a (worktree) agent. While it exists, verify the worktree has the file:
```bash
ls ~/.kermanych/worktrees/*/.env
```
Expected: `.env` present in the session worktree.

- [ ] **Step 4: Verify the token works inside the session**

In the session (or its worktree dir) confirm `gh` authenticates with the carried token:
```bash
cd ~/.kermanych/worktrees/<id>
export GH_TOKEN=$(sed -n 's/^GITHUB_TOKEN=//p' .env | head -1 | tr -d '\r\n')
gh repo view ashton-jpg/platinum-os --json nameWithOwner -q .nameWithOwner
```
Expected: prints `ashton-jpg/platinum-os` (auth works via the carried PAT).

- [ ] **Step 5: Clean up**

Delete the session (worktree + its `.env` copy removed) and remove `KMQ_TEST` via the ⚙ editor; confirm it is gone from `platinum-os/.env`.

- [ ] **Step 6: Full suites**

Run: `pnpm --filter @kermanych/api exec vitest run && pnpm --filter @kermanych/core exec vitest run`
Expected: PASS.

---

## Self-Review

**Spec coverage:**
- carryFiles model + default `[".env"]` → Tasks 1, 2.
- Copy into worktree, skip missing, cleanup on failure → Task 5.
- In-app `.env` editor, masked values → Tasks 9, 10.
- Safe write (surgical, quoted, atomic) → Tasks 3, 4.
- Path confinement → Task 4.
- `ignored` warning → Tasks 4 (API), 9 (UI).
- No secret storage in DB → enforced (only `carryFiles` persisted; values live in the file).
- HTTP `GET/PUT /groups/:id/env` + carryFiles on create/update → Task 6.
- Verification (unit + smoke) → Tasks 2-5 (unit), 11 (smoke).

**Placeholder scan:** none — every code step is concrete. `<id>`/`<owner/repo>` in the manual smoke are runtime values the operator substitutes.

**Type consistency:** `EnvEntry`/`EnvFileView` (Task 1) are used identically across api (`env-text`, `env-file.service`, controller) and ui (`api.ts`, store, `KEnvEditor`). `saveEnv`/PUT body shape `{ file?, set?, remove? }` matches from UI → store → api client → controller → service. `carryFiles?: string[]` threads consistently through core → registry → supervisor → controller → api client → store → UI.

**Open follow-ups (non-blocking, out of scope per spec):** inline-comment-preserving value parsing; macOS-Keychain hardening; a dedicated per-existing-group carryFiles editor UI beyond the settings modal already added.
