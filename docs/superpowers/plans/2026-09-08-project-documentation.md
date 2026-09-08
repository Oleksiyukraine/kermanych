# Project Documentation Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project point at one or more folders inside its own git repository and render a faithful, GitHub-style preview of the real documentation files there — on a project view and aggregated across a workspace's projects — refreshed on pull.

**Architecture:** A new team-shared `doc_folders text[]` project column (threaded through cloud → local registry exactly like `carry_files`) names repo-relative folders. Three path-guarded `GET /projects/:id/docs/{tree,file,raw}` API routes read those folders from the machine's bound `localRepoPath` via the existing `WorktreeService` readers. The reserved `management-docs` "Project Documentation" screen lists the workspace's projects (the workspace aggregation) and renders a selected project's folders as a browsable tree + preview, using a docs-tuned `markdown-it` renderer and `highlight.js`. Content is read live and locally only (never uploaded); refresh piggybacks the existing pull button.

**Tech Stack:** NestJS (api), Quasar/Vue 3 + Pinia + vue-router (ui), Supabase Postgres (cloud), better-sqlite3 (local registry), markdown-it ^14, highlight.js ^11, vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-project-documentation-design.md`

## Global Constraints

- **Node ≥ 22.12**, **pnpm** (version pinned in root `package.json`).
- **No JSON blobs in schema** — project config is discrete typed columns; `doc_folders` is a `text[]` column, mirrored to the local registry as JSON **text** exactly as `carry_files` is (`registry.service.ts:112`, `:250`, `:279`, `:291`).
- **Decision A (local only):** documentation content is read from this machine's bound `localRepoPath` and is **never** uploaded to the cloud or aggregated server-side. Only the folder *selection* lives in the cloud.
- **Faithful render, no AI:** the preview is the real files rendered GitHub-style. Keep `markdown-it` `html: false` (raw HTML stays escaped). No summarization anywhere in this feature.
- **Reuse the doc taxonomy** in `packages/core/src/docs.ts` (`isDocPath`); never define a second one.
- **Reuse the guarded readers** `WorktreeService.listTree` / `readFileContent`; never hand-roll path handling.
- **i18n Ukrainian-first:** every user-facing string is added to `apps/ui/src/i18n/uk/index.ts` first, then mirrored in `apps/ui/src/i18n/en/index.ts`. Ukrainian is the primary locale.
- **`@kermanych/cloud` barrel:** any new exported symbol must be added to `packages/cloud/src/index.ts` or Vite's CJS interop yields `undefined`.
- **The screen is read-only:** `management-docs` becomes `capability: "read"` — the assistant may mention it, never write it.
- Run per-package validation only (the task's own vitest file); the full suite / lint runs once at the end.

---

### Task 1: Cloud schema — `doc_folders` column

**Files:**
- Create: `kermanych/supabase/migrations/20260908090000_project_doc_folders.sql`

**Interfaces:**
- Produces: a `public.projects.doc_folders text[] not null default '{}'` column readable/writable by the existing project RLS policies (no policy change — it is ordinary project config).

- [ ] **Step 1: Write the migration**

```sql
-- Per-project documentation folders: repo-relative POSIX directory paths whose
-- files the Project Documentation screen renders. Team-shared SELECTION only —
-- the file CONTENT is read from each developer's local checkout and never stored
-- here. Column-only, like carry_files; no JSON blob. Existing project-update RLS
-- (projects_update_member) already covers it, so no policy is added.
alter table public.projects
  add column doc_folders text[] not null default '{}';
```

- [ ] **Step 2: Verify it applies**

Run (from `kermanych/`): `pnpm supabase db reset` if a local Supabase is running, otherwise confirm the file parses with `pnpm supabase db lint` (or a `psql` dry parse). Expected: no error; `projects` now has `doc_folders`.

- [ ] **Step 3: Commit**

```bash
git add kermanych/supabase/migrations/20260908090000_project_doc_folders.sql
git commit -m "feat(cloud): add projects.doc_folders column"
```

---

### Task 2: Cloud mappers + type — thread `doc_folders`

**Files:**
- Modify: `kermanych/packages/cloud/src/types.ts:26-46` (`CloudProject`)
- Modify: `kermanych/packages/cloud/src/projects.ts:10-11,13-28,33-38,40-62,66-84` (columns, row type, patch type, mappers)
- Test: `kermanych/packages/cloud/test/projects.spec.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CloudProject.docFolders: string[]`; `CloudProjectPatch` accepts `docFolders?: string[]`; `toCloudProject`/`toProjectRow` map the `doc_folders` column.

- [ ] **Step 1: Write the failing test**

Create `kermanych/packages/cloud/test/projects.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCloudProject, toProjectRow } from "../src/projects";

describe("doc_folders mapping", () => {
  it("maps a doc_folders row to docFolders", () => {
    const p = toCloudProject({
      id: "p1", name: "P", workspace_id: "w1", git_remote_url: null,
      conventions: null, preview_command: null, api_command: null,
      default_branch: null, default_model: null, default_effort: null,
      carry_files: [".env"], env_keys: [], color: null,
      doc_folders: ["docs", "packages/core/docs"], created_at: "t",
    });
    expect(p.docFolders).toEqual(["docs", "packages/core/docs"]);
  });

  it("defaults a null doc_folders to []", () => {
    const p = toCloudProject({
      id: "p1", name: "P", workspace_id: "w1", git_remote_url: null,
      conventions: null, preview_command: null, api_command: null,
      default_branch: null, default_model: null, default_effort: null,
      carry_files: null, env_keys: null, color: null,
      doc_folders: null, created_at: "t",
    });
    expect(p.docFolders).toEqual([]);
  });

  it("sends doc_folders only when present in the patch", () => {
    expect(toProjectRow({}).doc_folders).toBeUndefined();
    expect(toProjectRow({ docFolders: ["docs"] }).doc_folders).toEqual(["docs"]);
    expect(toProjectRow({ docFolders: [] }).doc_folders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `kermanych/packages/cloud`): `pnpm vitest run test/projects.spec.ts`
Expected: FAIL — `doc_folders` not in `ProjectRow` type / `docFolders` undefined.

- [ ] **Step 3: Implement the mapping**

In `types.ts`, add to `CloudProject` (after `envKeys`, before `color`):

```ts
  // Repo-relative POSIX directory paths whose files the Project Documentation screen
  // renders. Team-shared selection; the content is read from each machine's local
  // checkout, never stored in the cloud.
  docFolders: string[];
```

In `projects.ts`:

Extend `PROJECT_COLUMNS` (line 10-11) — append `, doc_folders`:

```ts
const PROJECT_COLUMNS =
  "id, name, workspace_id, git_remote_url, conventions, preview_command, api_command, default_branch, default_model, default_effort, carry_files, env_keys, color, doc_folders, created_at";
```

Add to `ProjectRow` (after `color: string | null;`):

```ts
  doc_folders: string[] | null;
```

Add `"docFolders"` to the `CloudProjectPatch` `Pick` union (line 33-38):

```ts
export type CloudProjectPatch = Partial<
  Pick<
    CloudProject,
    "name" | "workspaceId" | "gitRemoteUrl" | "conventions" | "previewCommand" | "apiCommand" | "defaultBranch" | "defaultModel" | "carryFiles" | "envKeys" | "docFolders" | "color"
  >
> & { defaultEffort?: ThinkingLevel | "" };
```

In `toCloudProject`, set it defensively alongside `carryFiles` (inside the initial `p` literal):

```ts
    docFolders: row.doc_folders ?? [],
```

In `toProjectRow`, add next to `carry_files` (line 80):

```ts
  if (patch.docFolders !== undefined) row.doc_folders = patch.docFolders;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/projects.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kermanych/packages/cloud/src/types.ts kermanych/packages/cloud/src/projects.ts kermanych/packages/cloud/test/projects.spec.ts
git commit -m "feat(cloud): thread docFolders through project mappers"
```

---

### Task 3: Core `Project` type — add `docFolders`

**Files:**
- Modify: `kermanych/packages/core/src/types.ts:18-22` (`Project`)

**Interfaces:**
- Produces: `Project.docFolders?: string[]` (local row shape).

- [ ] **Step 1: Add the field**

In `Project` (line 22), add `docFolders?: string[]` right after `carryFiles?: string[]`:

```ts
export type Project = { id: string; name: string; localRepoPath: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; docFolders?: string[]; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel; conventions?: string; createdAt: string };
```

- [ ] **Step 2: Verify it typechecks**

Run (from `kermanych/packages/core`): `pnpm exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add kermanych/packages/core/src/types.ts
git commit -m "feat(core): add Project.docFolders"
```

---

### Task 4: Local registry — `doc_folders` column + mapping

**Files:**
- Modify: `kermanych/apps/api/src/registry/registry.service.ts:110-115` (migration), `:244-251` (`listProjects`), `:256-282` (`upsertProject`), `:285-293` (`patchProject`)
- Test: `kermanych/apps/api/test/registry.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `Project.docFolders` (Task 3).
- Produces: registry `listProjects()` returns `docFolders: string[]`; `upsertProject`/`patchProject` persist it as JSON text.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/registry.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

function reg() {
  return new RegistryService(":memory:");
}

describe("registry doc_folders", () => {
  it("defaults docFolders to [] and round-trips a set value", () => {
    const r = reg();
    const created = r.upsertProject({ id: "p1", name: "P" });
    expect(created.docFolders).toEqual([]);

    const patched = r.patchProject("p1", { docFolders: ["docs", "guide"] });
    expect(patched.docFolders).toEqual(["docs", "guide"]);
    expect(r.listProjects().find((p) => p.id === "p1")!.docFolders).toEqual(["docs", "guide"]);
  });

  it("preserves docFolders across an upsert that omits it", () => {
    const r = reg();
    r.upsertProject({ id: "p1", name: "P", docFolders: ["docs"] });
    r.upsertProject({ id: "p1", name: "P renamed" });
    expect(r.listProjects().find((p) => p.id === "p1")!.docFolders).toEqual(["docs"]);
  });
});
```

Note: the second test asserts the same "keep existing value when the cloud omits it" guarantee `carry_files` and `local_repo_path` already provide. If `upsertProject` currently overwrites `carry_files` from the incoming row unconditionally, mirror whatever it does for `carry_files` — read `:256-282` and follow it exactly; adjust this test's expectation only if `carry_files` itself is not preserved on a bare upsert.

- [ ] **Step 2: Run test to verify it fails**

Run (from `kermanych/apps/api`): `pnpm vitest run test/registry.spec.ts`
Expected: FAIL — `docFolders` undefined.

- [ ] **Step 3: Add the migration**

After the `carry_files` migration block (`registry.service.ts:110-115`), add:

```ts
    // Additive migration: per-project documentation folders arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN doc_folders TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      /* column already exists */
    }
```

- [ ] **Step 4: Map it in the three project methods**

In `listProjects` (SELECT at `:244-246`) add `doc_folders as docFolders` after `carry_files as carryFiles`:

```ts
        `SELECT id, name, local_repo_path as localRepoPath, color, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, doc_folders as docFolders, default_branch as defaultBranch, default_model as defaultModel, default_effort as defaultEffort, conventions, created_at as createdAt FROM projects ORDER BY created_at`,
```

The row cast (`:247`) and the `.map` (`:250`) must parse it as JSON — mirror `carryFiles`:

```ts
      .all() as (Omit<Project, "carryFiles" | "docFolders"> & { carryFiles: string; docFolders: string })[];
```
```ts
    return rows.map((r) => ({ ...r, localRepoPath: r.localRepoPath ?? "", carryFiles: JSON.parse(r.carryFiles) as string[], docFolders: JSON.parse(r.docFolders) as string[], color: r.color ?? undefined, defaultBranch: r.defaultBranch ?? undefined, defaultModel: r.defaultModel ?? undefined, defaultEffort: r.defaultEffort ?? undefined, conventions: r.conventions ?? undefined }));
```

In `upsertProject` (`:256-282`): add `docFolders: p.docFolders ?? []` to the `row` object (next to `carryFiles: p.carryFiles ?? [".env"]`), add `doc_folders` to the INSERT column list and its `?`, add `doc_folders = excluded.doc_folders` to the `ON CONFLICT ... DO UPDATE SET`, and pass `JSON.stringify(row.docFolders)` in the matching `.run(...)` position. Keep the exact column/`?`/value ordering aligned.

In `patchProject` (`:285-293`): add `docFolders?: string[]` to the `patch` parameter type, add `doc_folders=?` to the `UPDATE ... SET` list, and pass `JSON.stringify(next.docFolders ?? [])` in the matching `.run(...)` position.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/registry.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/api/src/registry/registry.service.ts kermanych/apps/api/test/registry.spec.ts
git commit -m "feat(api): persist docFolders in the local registry"
```

---

### Task 5: Thread `docFolders` through the update path (supervisor, controller, sync, api client)

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts:277-286` (`updateProject`), `:303-318` (`syncProjects`)
- Modify: `kermanych/apps/api/src/http/projects.controller.ts:36-46` (`update` body)
- Modify: `kermanych/apps/ui/src/lib/api.ts:232-235` (`patchProject` body)
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts:189-191` (`patchProject` wrapper body type)

**Interfaces:**
- Consumes: registry `patchProject`/`upsertProject` with `docFolders` (Task 4), cloud `CloudProject.docFolders` (Task 2).
- Produces: `PATCH /projects/:id` accepts `docFolders?: string[]`; `syncProjects` copies `docFolders` cloud→registry.

- [ ] **Step 1: Supervisor `updateProject` — accept docFolders**

Add `docFolders?: string[]` to the `patch` parameter type on `updateProject` (`:277`). No body change needed — it forwards `patch` to `registry.patchProject` which now handles it.

- [ ] **Step 2: Supervisor `syncProjects` — copy docFolders down**

In the `upsertProject({...})` call (`:305-316`), add:

```ts
        docFolders: c.docFolders,
```

- [ ] **Step 3: Controller `update` — widen the body type**

`projects.controller.ts:39` — add `docFolders?: string[]` to the `@Body()` type:

```ts
    @Body() b: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; docFolders?: string[]; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel | ""; conventions?: string },
```

- [ ] **Step 4: UI api client + orchestrator wrapper — widen the body type**

`api.ts:234` and `orchestrator.ts:189` — add `docFolders?: string[]` to each `body` type (same shape as the controller).

- [ ] **Step 5: Verify typecheck**

Run (from `kermanych/`): `pnpm -r exec tsc --noEmit` (or per-package `tsc --noEmit` for api + ui).
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/src/http/projects.controller.ts kermanych/apps/ui/src/lib/api.ts kermanych/apps/ui/src/stores/orchestrator.ts
git commit -m "feat(api): accept docFolders on project update + sync"
```

---

### Task 6: `WorktreeService.readFileBytes` + a mime helper

**Files:**
- Modify: `kermanych/apps/api/src/worktree/worktree.service.ts` (add method near `readFileContent` at `:286-300`; add a mime map near the top constants `:15-25`)
- Test: `kermanych/apps/api/test/worktree-docs.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorktreeService.readFileBytes(dir: string, rel: string): Promise<{ bytes: Buffer; contentType: string } | null>` — guarded exactly like `readFileContent`; `null` when the path is not a readable file.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/worktree-docs.spec.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeService } from "../src/worktree/worktree.service";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wt-docs-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

describe("WorktreeService.readFileBytes", () => {
  const svc = new WorktreeService();

  it("returns bytes + a content-type for a known extension", async () => {
    const dir = fixture();
    const r = await svc.readFileBytes(dir, "docs/logo.png");
    expect(r).not.toBeNull();
    expect(r!.contentType).toBe("image/png");
    expect(r!.bytes.length).toBe(4);
  });

  it("rejects a path that escapes the dir", async () => {
    const dir = fixture();
    await expect(svc.readFileBytes(dir, "../secret")).rejects.toThrow("invalid path");
  });

  it("returns null for a missing file", async () => {
    const dir = fixture();
    expect(await svc.readFileBytes(dir, "docs/nope.png")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `kermanych/apps/api`): `pnpm vitest run test/worktree-docs.spec.ts`
Expected: FAIL — `readFileBytes` is not a function.

- [ ] **Step 3: Implement the mime map + method**

Add near the top constants (after `:25`):

```ts
// A small extension→MIME table for the docs raw route. Anything not listed streams as
// application/octet-stream, which a browser downloads rather than mis-renders.
const DOC_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".ico": "image/x-icon",
  ".bmp": "image/bmp", ".pdf": "application/pdf",
};
```

Add the method next to `readFileContent` (after `:300`):

```ts
  // Raw bytes of a file under `dir`, for the docs image/binary route. Same rel guard as
  // readFileContent; `null` when the path is not a readable file so the caller answers 404
  // instead of throwing. Oversized blobs are still returned — an image is meant to be sent
  // whole — but the same MAX_COUNT_BYTES ceiling caps it so one file cannot stream forever.
  async readFileBytes(dir: string, rel: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const p = rel.trim();
    if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.split(/[\\/]/).includes("..")) {
      throw new Error("invalid path");
    }
    const abs = join(dir, p);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > MAX_COUNT_BYTES) return null;
      const dot = p.lastIndexOf(".");
      const ext = dot === -1 ? "" : p.slice(dot).toLowerCase();
      return { bytes: await readFile(abs), contentType: DOC_MIME[ext] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/worktree-docs.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/worktree/worktree.service.ts kermanych/apps/api/test/worktree-docs.spec.ts
git commit -m "feat(api): add WorktreeService.readFileBytes for docs"
```

---

### Task 7: Supervisor docs methods — folder validation + guarded reads

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (add after `projectPull` at `:344-346`; `boundProject` is at `:265`)
- Test: `kermanych/apps/api/test/supervisor-docs.spec.ts` (create)

**Interfaces:**
- Consumes: `Project.docFolders` (registry), `WorktreeService.listTree`/`readFileContent`/`readFileBytes`.
- Produces:
  - `docsTree(projectId: string, folder: string, path: string): Promise<TreeEntry[]>`
  - `docsFile(projectId: string, folder: string, path: string): Promise<FileContent>`
  - `docsRaw(projectId: string, folder: string, path: string): Promise<{ bytes: Buffer; contentType: string } | null>`
  - each throws `Error("project not bound")` when unbound and `Error("unknown doc folder")` when `folder ∉ docFolders`.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/supervisor-docs.spec.ts`. Construct a `SupervisorService` the way the existing supervisor tests do (follow the setup in any current `test/*supervisor*.spec.ts`; if none exists, build it with a `RegistryService(":memory:")`, a real `WorktreeService`, and stubs/`undefined` for the other injected deps that these three methods never touch). Then:

```ts
// Pseudocode shape — adapt construction to the existing supervisor test harness.
// A bound project whose repo has docs/intro.md and a configured folder "docs".
it("lists a configured folder's tree", async () => {
  // bind project p1 to a temp git repo containing docs/intro.md, set docFolders=["docs"]
  const tree = await sup.docsTree("p1", "docs", "");
  expect(tree.map((e) => e.name)).toContain("intro.md");
});

it("rejects a folder not in docFolders", async () => {
  await expect(sup.docsTree("p1", "secrets", "")).rejects.toThrow("unknown doc folder");
});

it("rejects when the project is unbound", async () => {
  // project p2 with localRepoPath ""
  await expect(sup.docsTree("p2", "docs", "")).rejects.toThrow("project not bound");
});

it("reads a file inside a configured folder", async () => {
  const f = await sup.docsFile("p1", "docs", "intro.md");
  expect(f.content).toContain("# Intro");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `kermanych/apps/api`): `pnpm vitest run test/supervisor-docs.spec.ts`
Expected: FAIL — `docsTree` is not a function.

- [ ] **Step 3: Implement the three methods**

Add after `projectPull` (`:346`). `boundProject(projectId)` (`:265`) already returns the bound `Project` or throws `"project not bound"`:

```ts
  // The docs preview reads files from a folder the project PUBLISHED (project.docFolders)
  // inside its bound local checkout. Two guards before any disk access: the project must be
  // bound (boundProject throws otherwise), and `folder` must be one the project actually
  // published — a client may not read an arbitrary directory by naming it here. `folder` is
  // also checked for a `..`/absolute escape; `path` is guarded by the WorktreeService readers.
  private docsDir(projectId: string, folder: string): string {
    const project = this.boundProject(projectId);
    const f = folder.trim();
    if (f.startsWith("/") || /^[a-zA-Z]:/.test(f) || f.split(/[\\/]/).includes("..")) {
      throw new Error("invalid doc folder");
    }
    if (!(project.docFolders ?? []).includes(f)) throw new Error("unknown doc folder");
    return join(project.localRepoPath, f);
  }

  async docsTree(projectId: string, folder: string, path: string): Promise<TreeEntry[]> {
    try {
      return await this.worktree.listTree(this.docsDir(projectId, folder), path);
    } catch (err) {
      // A configured folder absent from THIS checkout is an empty listing, not an error;
      // the validation errors above still propagate.
      if (err instanceof Error && /unknown doc folder|invalid doc folder|project not bound|invalid path/.test(err.message)) throw err;
      return [];
    }
  }

  async docsFile(projectId: string, folder: string, path: string): Promise<FileContent> {
    return this.worktree.readFileContent(this.docsDir(projectId, folder), path);
  }

  async docsRaw(projectId: string, folder: string, path: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    return this.worktree.readFileBytes(this.docsDir(projectId, folder), path);
  }
```

Add `join` to the `node:path` import at the top of the file if not already imported, and `TreeEntry`/`FileContent` to the `@kermanych/core` type import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/supervisor-docs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/supervisor/supervisor.service.ts kermanych/apps/api/test/supervisor-docs.spec.ts
git commit -m "feat(api): supervisor docs tree/file/raw with folder validation"
```

---

### Task 8: Docs API routes on `ProjectsController`

**Files:**
- Modify: `kermanych/apps/api/src/http/projects.controller.ts` (add routes; add imports)

**Interfaces:**
- Consumes: `SupervisorService.docsTree`/`docsFile`/`docsRaw` (Task 7).
- Produces:
  - `GET /projects/:id/docs/tree?folder=&path=` → `TreeEntry[]`
  - `GET /projects/:id/docs/file?folder=&path=` → `FileContent`
  - `GET /projects/:id/docs/raw?folder=&path=` → raw bytes with `Content-Type`

- [ ] **Step 1: Add the routes**

Add to `ProjectsController` (after the `pull` route, before `getEnv`). Update the imports on line 2 to include `Res` and `NotFoundException`, and add `import type { Response } from "express";`:

```ts
  @Get(":id/docs/tree")
  async docsTree(@Param("id") id: string, @Query("folder") folder: string, @Query("path") path?: string) {
    try {
      return await this.sup.docsTree(id, folder ?? "", path ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/docs/file")
  async docsFile(@Param("id") id: string, @Query("folder") folder: string, @Query("path") path?: string) {
    try {
      return await this.sup.docsFile(id, folder ?? "", path ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/docs/raw")
  async docsRaw(
    @Param("id") id: string,
    @Query("folder") folder: string,
    @Query("path") path: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    let file: { bytes: Buffer; contentType: string } | null;
    try {
      file = await this.sup.docsRaw(id, folder ?? "", path ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    if (!file) throw new NotFoundException("file not found");
    res.setHeader("Content-Type", file.contentType);
    return file.bytes;
  }
```

- [ ] **Step 2: Smoke-verify the routes resolve**

Run (from `kermanych/apps/api`): `pnpm build` (or `pnpm exec tsc --noEmit`).
Expected: compiles; Nest route order is fine (`:id/docs/*` are distinct literals under `:id`).

- [ ] **Step 3: Commit**

```bash
git add kermanych/apps/api/src/http/projects.controller.ts
git commit -m "feat(api): GET /projects/:id/docs/{tree,file,raw} routes"
```

---

### Task 9: UI api client — docs endpoints + docFolders patch + blob helper

**Files:**
- Modify: `kermanych/apps/ui/src/lib/api.ts` (add `getBlob` helper near `get` at `:119-123`; add the four methods to the `api` object)

**Interfaces:**
- Consumes: the Task 8 routes.
- Produces on `api`:
  - `projectDocsTree(id, folder, path): Promise<TreeEntry[]>`
  - `projectDocsFile(id, folder, path): Promise<FileContent>`
  - `projectDocsRaw(id, folder, path): Promise<Blob>`
  - `patchProject` already carries `docFolders?` from Task 5.

- [ ] **Step 1: Add the `getBlob` helper**

After `get` (`:123`):

```ts
async function getBlob(path: string): Promise<Blob> {
  const r = await fetch(BASE + path, { headers: authHeaders(false) });
  if (!r.ok) throw await toError(r);
  return await r.blob();
}
```

- [ ] **Step 2: Add the three methods to the `api` object**

Next to `sessionTree`/`sessionFile` (`:461-465`):

```ts
  projectDocsTree: (id: string, folder: string, path: string): Promise<TreeEntry[]> =>
    get<TreeEntry[]>(`/projects/${id}/docs/tree?folder=${encodeURIComponent(folder)}${path ? `&path=${encodeURIComponent(path)}` : ''}`),

  projectDocsFile: (id: string, folder: string, path: string): Promise<FileContent> =>
    get<FileContent>(`/projects/${id}/docs/file?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`),

  projectDocsRaw: (id: string, folder: string, path: string): Promise<Blob> =>
    getBlob(`/projects/${id}/docs/raw?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`),
```

- [ ] **Step 3: Verify typecheck**

Run (from `kermanych/apps/ui`): `pnpm exec vue-tsc --noEmit` (or the project's typecheck script).
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui/src/lib/api.ts
git commit -m "feat(ui): docs api client methods + blob helper"
```

---

### Task 10: Docs-tuned markdown renderer

**Files:**
- Modify: `kermanych/apps/ui/src/lib/markdown.ts`
- Test: `kermanych/apps/ui/test/markdown-doc.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `resolveRel(dir: string, rel: string): string | null` — pure POSIX resolution of a relative link against a folder-relative `dir`; `null` if it escapes the folder root, is absolute, or is external/anchor.
  - `renderDoc(src: string, base: { folder: string; dir: string }): string` — GitHub-tuned HTML. Relative images become `<img data-doc-folder data-doc-path>` (no `src`); relative links become `<a data-doc-folder data-doc-path>`; external/anchor links and absolute image URLs are unchanged. Fenced code is highlighted. `html: false` retained.

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/ui/test/markdown-doc.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderDoc, resolveRel } from "../src/lib/markdown";

const base = { folder: "docs", dir: "guide" }; // rendering docs/guide/page.md

describe("resolveRel", () => {
  it("resolves a sibling", () => expect(resolveRel("guide", "./img.png")).toBe("guide/img.png"));
  it("resolves a parent hop still inside the folder", () => expect(resolveRel("guide/sub", "../img.png")).toBe("guide/img.png"));
  it("rejects an escape above the folder root", () => expect(resolveRel("guide", "../../etc/passwd")).toBeNull());
  it("rejects an external url", () => expect(resolveRel("guide", "https://x/y.png")).toBeNull());
  it("rejects a bare anchor", () => expect(resolveRel("guide", "#section")).toBeNull());
});

describe("renderDoc", () => {
  it("does not turn a single newline into <br> (breaks:false)", () => {
    expect(renderDoc("a\nb", base)).not.toContain("<br");
  });

  it("highlights a fenced code block", () => {
    const html = renderDoc("```js\nconst x = 1;\n```", base);
    expect(html).toContain('class="hljs');
  });

  it("rewrites a relative image to data attributes with no src", () => {
    const html = renderDoc("![logo](./logo.png)", base);
    expect(html).toContain('data-doc-folder="docs"');
    expect(html).toContain('data-doc-path="guide/logo.png"');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
  });

  it("keeps an absolute image url as a normal src", () => {
    const html = renderDoc("![x](https://cdn/x.png)", base);
    expect(html).toContain('src="https://cdn/x.png"');
  });

  it("rewrites a relative doc link to data attributes", () => {
    const html = renderDoc("[next](./other.md)", base);
    expect(html).toContain('data-doc-folder="docs"');
    expect(html).toContain('data-doc-path="guide/other.md"');
  });

  it("escapes embedded raw HTML (html:false kept)", () => {
    expect(renderDoc("<script>alert(1)</script>", base)).not.toContain("<script>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `kermanych/apps/ui`): `pnpm vitest run test/markdown-doc.spec.ts`
Expected: FAIL — `renderDoc`/`resolveRel` not exported.

- [ ] **Step 3: Implement the renderer**

Append to `apps/ui/src/lib/markdown.ts` (keep the existing `renderMarkdown` untouched):

```ts
import hljs from 'highlight.js/lib/common';

// Resolve a relative link/image target against `dir` (the current file's folder, relative to
// the doc-folder root). Returns a folder-relative POSIX path, or null when the target is
// absolute, external, a bare anchor, or escapes above the folder root — those are left for
// the browser to handle (or dropped) rather than turned into a docs reference.
export function resolveRel(dir: string, rel: string): string | null {
  const t = rel.trim();
  if (!t || t.startsWith('#') || t.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null;
  const clean = t.split(/[?#]/, 1)[0]!;
  const parts = (dir ? dir.split('/') : []).filter((s) => s && s !== '.');
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escaped above the folder root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/') || null;
}

const DOC_LINK_RE = /\.(?:md|mdx|mdc|markdown|rst|adoc|asciidoc)$/i;

// GitHub-faithful renderer for repository documentation. Distinct instance from the chat
// renderMarkdown: breaks:false (a single newline is not a <br>), fenced code highlighted, and
// relative image/link targets rewritten to data-* attributes the docs screen resolves against
// the authed raw endpoint (images) or in-app tree navigation (doc links). html:false is kept,
// so embedded raw HTML stays escaped and v-html output is a controlled tag set.
const docMd: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(str: string, lang: string): string {
    try {
      const out = lang && hljs.getLanguage(lang)
        ? hljs.highlight(str, { language: lang }).value
        : hljs.highlightAuto(str).value;
      return `<pre class="hljs"><code>${out}</code></pre>`;
    } catch {
      return '';
    }
  },
});

export function renderDoc(src: string, base: { folder: string; dir: string }): string {
  const attr = (path: string) =>
    ` data-doc-folder="${docMd.utils.escapeHtml(base.folder)}" data-doc-path="${docMd.utils.escapeHtml(path)}"`;

  docMd.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]!;
    const src0 = token.attrGet('src') ?? '';
    const alt = docMd.utils.escapeHtml(token.content);
    const rel = resolveRel(base.dir, src0);
    if (rel) return `<img${attr(rel)} alt="${alt}">`;
    // External/absolute image: keep its src (still html:false-escaped by markdown-it).
    return `<img src="${docMd.utils.escapeHtml(src0)}" alt="${alt}">`;
  };

  docMd.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') ?? '';
    const rel = resolveRel(base.dir, href);
    if (rel && DOC_LINK_RE.test(rel.split(/[?#]/, 1)[0]!)) {
      return `<a href="#"${attr(rel)}>`;
    }
    // External links open in a new tab; anchors/other relative links pass through.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
    return self.renderToken(tokens, idx, options);
  };

  return docMd.render(src ?? '');
}
```

Note: the existing top-of-file `import MarkdownIt from 'markdown-it';` is reused; add the `hljs` import at the top with the others. Also add `import 'highlight.js/styles/github-dark.css';` once at the app style entry if the theme is not already global (it is imported by `KFileView.vue`; importing it there is sufficient since that component ships in the same bundle — verify by rendering a code block in the smoke test).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/markdown-doc.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/lib/markdown.ts kermanych/apps/ui/test/markdown-doc.spec.ts
git commit -m "feat(ui): docs-tuned markdown renderer (renderDoc)"
```

---

### Task 11: `project-docs` Pinia store

**Files:**
- Create: `kermanych/apps/ui/src/stores/project-docs.ts`

**Interfaces:**
- Consumes: `api.projectDocsTree`/`projectDocsFile`/`projectDocsRaw` (Task 9), `useProjects` (cloud rows for `docFolders`), `useOrchestrator` (local rows for `localRepoPath`, `selectedProjectId`).
- Produces `useProjectDocs()` with:
  - state: `activeProjectId: string`, `openFolder: string`, `openPath: string`, `file: FileContent | null`, `loadingFile: boolean`, `fileError: string | null`.
  - `setActive(projectId: string): void`
  - `treeOf(projectId, folder, path): Promise<TreeEntry[]>`
  - `openFile(projectId, folder, path): Promise<void>`
  - `rawUrl(projectId, folder, path): Promise<string>` — fetches the blob once, returns a cached object URL.
  - `refreshIfActive(projectId): void` — re-open the current file when `projectId === activeProjectId`.
  - `releaseUrls(): void` — revoke object URLs (called on page unmount).

- [ ] **Step 1: Create the store**

```ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FileContent, TreeEntry } from '@kermanych/core';
import { api } from '../lib/api';

// Read-only view state for the Project Documentation screen. It owns NO document content of
// its own: trees and files are fetched live from the bound local checkout through the api on
// every navigation (decision A — nothing is cached in the cloud), and raw image bytes are
// turned into object URLs (the raw route needs the auth bearer, which an <img src> cannot
// carry, so the bytes are fetched by the authed api client and handed to the DOM as a blob).
export const useProjectDocs = defineStore('project-docs', () => {
  const activeProjectId = ref('');
  const openFolder = ref('');
  const openPath = ref('');
  const file = ref<FileContent | null>(null);
  const loadingFile = ref(false);
  const fileError = ref<string | null>(null);

  const urlCache = new Map<string, string>();

  function setActive(projectId: string): void {
    if (projectId === activeProjectId.value) return;
    activeProjectId.value = projectId;
    openFolder.value = '';
    openPath.value = '';
    file.value = null;
    fileError.value = null;
  }

  async function treeOf(projectId: string, folder: string, path: string): Promise<TreeEntry[]> {
    return api.projectDocsTree(projectId, folder, path);
  }

  async function openFile(projectId: string, folder: string, path: string): Promise<void> {
    openFolder.value = folder;
    openPath.value = path;
    loadingFile.value = true;
    fileError.value = null;
    try {
      file.value = await api.projectDocsFile(projectId, folder, path);
    } catch (e) {
      file.value = null;
      fileError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loadingFile.value = false;
    }
  }

  async function rawUrl(projectId: string, folder: string, path: string): Promise<string> {
    const key = `${projectId}\u0000${folder}\u0000${path}`;
    const hit = urlCache.get(key);
    if (hit) return hit;
    const blob = await api.projectDocsRaw(projectId, folder, path);
    const url = URL.createObjectURL(blob);
    urlCache.set(key, url);
    return url;
  }

  function refreshIfActive(projectId: string): void {
    if (projectId !== activeProjectId.value || !openFolder.value || !openPath.value) return;
    // A pull may have changed images too; drop the object-URL cache so they refetch.
    releaseUrls();
    void openFile(projectId, openFolder.value, openPath.value);
  }

  function releaseUrls(): void {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
  }

  return { activeProjectId, openFolder, openPath, file, loadingFile, fileError, setActive, treeOf, openFile, rawUrl, refreshIfActive, releaseUrls };
});
```

- [ ] **Step 2: Verify typecheck**

Run (from `kermanych/apps/ui`): `pnpm exec vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add kermanych/apps/ui/src/stores/project-docs.ts
git commit -m "feat(ui): project-docs store"
```

---

### Task 12: Promote the `management-docs` section to a read screen

**Files:**
- Modify: `kermanych/packages/core/src/management.ts:92-99` (the `management-docs` entry)
- Modify: `kermanych/apps/ui/src/i18n/uk/index.ts` (`management.section.'management-docs'`) and `kermanych/apps/ui/src/i18n/en/index.ts` (mirror)

**Interfaces:**
- Consumes: nothing.
- Produces: `management-docs` with `capability: "read"` and a `limitation` explaining it renders repository files read-only.

- [ ] **Step 1: Change the section capability**

In `management.ts`, replace the `management-docs` object (`:92-99`):

```ts
  {
    name: "management-docs",
    path: "project-documentation",
    label: "Project Documentation",
    hint: "специфікації й рішення",
    capability: "read",
    limitation:
      "розділ показує документацію з репозиторіїв проєктів як є — асистент може лише згадати її, але не редагує файли",
  },
```

- [ ] **Step 2: Update the UI i18n meta**

In `apps/ui/src/i18n/uk/index.ts`, `management.section['management-docs']` currently carries the NOT_BUILT `limitation`. Replace its `limitation` with the read-only sentence above; keep `hint: 'специфікації й рішення'`. Mirror in `apps/ui/src/i18n/en/index.ts` (English `limitation`, e.g. "shows each project's repository documentation as-is — the assistant can mention it but does not edit the files").

- [ ] **Step 3: Verify typecheck**

Run (from `kermanych/`): per-package `tsc --noEmit` for core + ui.
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add kermanych/packages/core/src/management.ts kermanych/apps/ui/src/i18n/uk/index.ts kermanych/apps/ui/src/i18n/en/index.ts
git commit -m "feat: promote management-docs section to a read screen"
```

---

### Task 13: Settings — documentation-folders editor

**Files:**
- Modify: `kermanych/apps/ui/src/pages/SettingsPage.vue` (project-git pane template `:123-142`; `ProjectDraft` `:785-795`; `seedProject` `:821-823`; `saveProject` body `:1100-1123`; add a `docInput` ref beside `carryInput` `:797-799`)
- Modify: `kermanych/apps/ui/src/i18n/uk/index.ts` + `en/index.ts` (`settings.docs.*`)

**Interfaces:**
- Consumes: `draft.docFolders` (new), `projects.patch(id, { docFolders })` (already accepts it via Task 2 `CloudProjectPatch`).
- Produces: the operator can add/remove repo-relative folders; saving persists `docFolders`.

- [ ] **Step 1: Add the field to `ProjectDraft` + seed**

`ProjectDraft` interface — add after `carryFiles: string[];`:

```ts
  docFolders: string[];
```

`seedProject` — where `carryFiles` is seeded (`:821-823`), add:

```ts
    docFolders: [...(c?.docFolders ?? row?.docFolders ?? [])],
```

and include it in the `draft.value = { ... }` spread with its own copy: `docFolders: [...next.docFolders]` (mirror the `carryFiles: [...next.carryFiles]` line). Add a ref beside `carryInput`:

```ts
const docInput = ref('');
```

and an `addDocFolder` beside `addCarryFile` (`:859-863`):

```ts
function addDocFolder(): void {
  const path = docInput.value.trim().replace(/^\/+|\/+$/g, '');
  docInput.value = '';
  if (!path || !draft.value || draft.value.docFolders.includes(path)) return;
  draft.value.docFolders.push(path);
}
```

- [ ] **Step 2: Add the editor to the `project-git` pane template**

In the `project-git` pane (`:123-142`), after the `conventions` `KField`, add a chip editor mirroring carryFiles:

```vue
          <div class="set__group">
            <span class="set__label">{{ t('settings.docs.folders') }}</span>
            <p v-if="!isBound" class="set__note">{{ t('settings.docs.bindHint') }}</p>
            <div class="set__chips">
              <span v-for="(f, i) in draft.docFolders" :key="`${f}-${i}`" class="set__chip mono">
                {{ f }}
                <button
                  type="button"
                  class="set__chip-x"
                  :aria-label="t('settings.docs.remove', { folder: f })"
                  :disabled="cloudLocked"
                  @click="draft.docFolders.splice(i, 1)"
                >✕</button>
              </span>
              <input
                v-model="docInput"
                class="set__chip-input mono"
                :placeholder="t('settings.docs.addPlaceholder')"
                :disabled="cloudLocked"
                @keydown.enter.prevent="addDocFolder"
                @blur="addDocFolder"
              />
            </div>
            <p class="set__note">{{ t('settings.docs.note') }}</p>
          </div>
```

- [ ] **Step 3: Persist in `saveProject`**

In the `projects.patch(id, { ... })` body (`:1100-1123`), add:

```ts
      docFolders: d.docFolders,
```

Also ensure `docFolders` participates in the dirty check so the save bar enables — in `lib/settings.ts` `changedFields` compares `carryFiles` by joined contents (comment `:333-337`); add `docFolders` to that comparison the same way (join and compare), so a folder edit marks the draft dirty.

- [ ] **Step 4: Add i18n keys (uk first, then en)**

`apps/ui/src/i18n/uk/index.ts` under `settings`:

```ts
    docs: {
      folders: 'Теки з документацією',
      addPlaceholder: 'додати теку (напр. docs)…',
      remove: 'Прибрати {folder}',
      bindHint: "Прив'яжіть локальний репозиторій, щоб бачити прев'ю документації.",
      note: 'Шляхи відносно кореня репозиторію. Прев\u2019ю показує файли як є, без змін.',
    },
```

`apps/ui/src/i18n/en/index.ts` under `settings` (mirror):

```ts
    docs: {
      folders: 'Documentation folders',
      addPlaceholder: 'add a folder (e.g. docs)…',
      remove: 'Remove {folder}',
      bindHint: 'Bind a local repository to preview its documentation.',
      note: 'Paths relative to the repository root. The preview shows files as-is.',
    },
```

- [ ] **Step 5: Verify typecheck + a quick manual render**

Run (from `kermanych/apps/ui`): `pnpm exec vue-tsc --noEmit`. Expected: clean. (Visual confirmation happens in Task 15's smoke test.)

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/ui/src/pages/SettingsPage.vue kermanych/apps/ui/src/lib/settings.ts kermanych/apps/ui/src/i18n/uk/index.ts kermanych/apps/ui/src/i18n/en/index.ts
git commit -m "feat(ui): documentation-folders editor in project settings"
```

---

### Task 14: The Project Documentation screen + pull refresh

**Files:**
- Create: `kermanych/apps/ui/src/pages/ProjectDocumentationPage.vue`
- Modify: `kermanych/apps/ui/src/router/routes.ts:16-23` (`SECTION_PAGES`)
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue:1074-1089` (`gitPull` → refresh docs)
- Modify: `kermanych/apps/ui/src/i18n/uk/index.ts` + `en/index.ts` (`docsPage.*`)

**Interfaces:**
- Consumes: `useProjectDocs` (Task 11), `useProjects` (`projectsByWorkspace`), `useOrchestrator` (`selectedProjectId`, local rows), `renderDoc` (Task 10), `api.projectDocsTree`.
- Produces: a registered `management-docs` screen; `gitPull` calls `useProjectDocs().refreshIfActive(id)` after a successful pull.

- [ ] **Step 1: Register the screen**

`routes.ts` `SECTION_PAGES` (`:16-23`) — add:

```ts
  'management-docs': () => import('pages/ProjectDocumentationPage.vue'),
```

- [ ] **Step 2: Create the page**

`ProjectDocumentationPage.vue`. It receives `{ workspaceId, workspaceName }` (the shell passes exactly these — see `ManagementPage.vue`'s `<router-view :workspace-id :workspace-name>`). It lists the workspace's projects from the cloud store, and for a selected project reads the LOCAL row (`useOrchestrator().projects`) to know `localRepoPath` (bind state) and `docFolders`.

```vue
<script setup lang="ts">
// The Project Documentation screen. Two levels in one place: the workspace's projects are
// listed (the workspace-level aggregation), and selecting one renders its configured doc
// folders as a browsable tree + a faithful GitHub-style preview of the actual repository
// files (decision A — read live from THIS machine's bound checkout; nothing is uploaded).
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TreeEntry } from '@kermanych/core';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjectDocs } from 'stores/project-docs';
import { renderDoc } from '../lib/markdown';
import KFileView from 'components/kit/KFileView.vue';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();
const { t } = useI18n();
const projects = useProjects();
const local = useOrchestrator();
const docs = useProjectDocs();

// Projects of this workspace (the aggregation).
const wsProjects = computed(() => projects.projectsByWorkspace.find((g) => g.workspace.id === props.workspaceId)?.projects ?? []);

const selectedId = ref('');
const localRow = computed(() => local.projects.find((p) => p.id === selectedId.value));
const docFolders = computed(() => localRow.value?.docFolders ?? []);
const isBound = computed(() => !!localRow.value?.localRepoPath);

// Pre-focus the sidebar's selected project if it belongs to this workspace.
watch(
  () => [props.workspaceId, local.selectedProjectId] as const,
  () => {
    const pre = wsProjects.value.find((p) => p.id === local.selectedProjectId)?.id;
    if (pre && pre !== selectedId.value) select(pre);
    else if (!selectedId.value && wsProjects.value[0]) select(wsProjects.value[0].id);
  },
  { immediate: true },
);

function select(id: string): void {
  selectedId.value = id;
  docs.setActive(id);
}

// Lazy one-level tree per folder node (folder root path is "").
type Node = { folder: string; path: string; name: string; type: 'dir' | 'file'; children?: Node[]; open?: boolean };
const roots = ref<Node[]>([]);

watch([selectedId, docFolders, isBound], async () => {
  roots.value = docFolders.value.map((f) => ({ folder: f, path: '', name: f, type: 'dir' as const }));
});

async function expand(node: Node): Promise<void> {
  if (node.type !== 'dir') return;
  node.open = !node.open;
  if (node.children || !node.open) return;
  const entries: TreeEntry[] = await docs.treeOf(selectedId.value, node.folder, node.path);
  node.children = entries.map((e) => ({ folder: node.folder, path: node.path ? `${node.path}/${e.name}` : e.name, name: e.name, type: e.type }));
}

function openFile(node: Node): void {
  if (node.type !== 'file') return;
  void docs.openFile(selectedId.value, node.folder, node.path);
}

const isMarkdown = computed(() => /\.(?:md|mdx|mdc|markdown|rst|adoc|asciidoc)$/i.test(docs.openPath));
const previewHtml = computed(() => {
  const f = docs.file;
  if (!f || f.binary || !isMarkdown.value) return '';
  const slash = docs.openPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : docs.openPath.slice(0, slash);
  return renderDoc(f.content, { folder: docs.openFolder, dir });
});

// After v-html paints, resolve relative images (authed blob → object URL) and wire relative
// doc links to in-app navigation. Re-run whenever the rendered HTML changes.
const previewEl = ref<HTMLElement | null>(null);
watch([previewHtml, previewEl], async () => {
  const el = previewEl.value;
  if (!el) return;
  for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img[data-doc-path]'))) {
    const folder = img.getAttribute('data-doc-folder')!;
    const path = img.getAttribute('data-doc-path')!;
    try { img.src = await docs.rawUrl(selectedId.value, folder, path); } catch { /* leave broken */ }
  }
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a[data-doc-path]'))) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const folder = a.getAttribute('data-doc-folder')!;
      const path = a.getAttribute('data-doc-path')!;
      void docs.openFile(selectedId.value, folder, path);
    });
  }
});

onBeforeUnmount(() => docs.releaseUrls());
</script>

<template>
  <div class="docs">
    <aside class="docs__projects">
      <button
        v-for="p in wsProjects"
        :key="p.id"
        type="button"
        class="docs__project"
        :class="{ 'docs__project--on': p.id === selectedId }"
        @click="select(p.id)"
      >{{ p.name }}</button>
      <p v-if="!wsProjects.length" class="docs__empty">{{ t('docsPage.noProjects') }}</p>
    </aside>

    <nav class="docs__tree">
      <template v-if="!selectedId"><p class="docs__empty">{{ t('docsPage.pickProject') }}</p></template>
      <template v-else-if="!isBound"><p class="docs__empty">{{ t('docsPage.bindPrompt') }}</p></template>
      <template v-else-if="!docFolders.length"><p class="docs__empty">{{ t('docsPage.noFolders') }}</p></template>
      <ul v-else class="docs__nodes">
        <li v-for="node in roots" :key="node.folder">
          <button class="docs__node docs__node--dir" type="button" @click="expand(node)">{{ node.open ? '▾' : '▸' }} {{ node.name }}</button>
          <ul v-if="node.open && node.children">
            <li v-for="child in node.children" :key="child.path">
              <button
                class="docs__node"
                type="button"
                @click="child.type === 'dir' ? expand(child) : openFile(child)"
              >{{ child.type === 'dir' ? (child.open ? '▾ ' : '▸ ') : '' }}{{ child.name }}</button>
              <!-- one level shown per expand; deeper dirs expand on click via the same handler -->
            </li>
          </ul>
        </li>
      </ul>
    </nav>

    <section class="docs__preview">
      <p v-if="docs.loadingFile" class="docs__empty">{{ t('docsPage.loading') }}</p>
      <p v-else-if="docs.fileError" class="docs__empty docs__empty--error">{{ docs.fileError }}</p>
      <template v-else-if="docs.file && !docs.file.binary && isMarkdown">
        <!-- renderDoc keeps html:false, so v-html output is a controlled tag set. -->
        <div ref="previewEl" class="k-log__markdown" v-html="previewHtml"></div>
      </template>
      <KFileView
        v-else-if="docs.file && !docs.file.binary"
        :path="docs.openPath"
        :file="docs.file"
      />
      <p v-else-if="docs.file && docs.file.binary" class="docs__empty">{{ t('docsPage.binary') }}</p>
      <p v-else class="docs__empty">{{ t('docsPage.pickFile') }}</p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.docs { display: grid; grid-template-columns: 200px 240px 1fr; gap: var(--k-sp-3); height: 100%; min-height: 0; }
.docs__projects, .docs__tree { overflow: auto; border-right: 1px solid var(--k-line); padding-right: var(--k-sp-2); display: flex; flex-direction: column; gap: 2px; }
.docs__project, .docs__node { text-align: left; background: none; border: 0; color: var(--k-text); cursor: pointer; padding: 4px 6px; border-radius: 6px; font: inherit; }
.docs__project--on { background: var(--k-surface-2); }
.docs__node:hover, .docs__project:hover { background: var(--k-surface-2); }
.docs__nodes, .docs__nodes ul { list-style: none; margin: 0; padding-left: var(--k-sp-2); }
.docs__preview { overflow: auto; min-height: 0; }
.docs__empty { color: var(--k-muted); font-size: 13px; padding: var(--k-sp-3); &--error { color: var(--k-danger); } }
</style>
```

- [ ] **Step 3: Wire pull refresh in `MainLayout.gitPull`**

Import the store at the top of `MainLayout.vue`'s script (`import { useProjectDocs } from 'stores/project-docs';` and `const projectDocs = useProjectDocs();`). In `gitPull` (`:1074-1089`), inside the `if (r.ok)` branch, after the notify call, add:

```ts
        projectDocs.refreshIfActive(id);
```

- [ ] **Step 4: Add page i18n (uk first, then en)**

`uk/index.ts` top-level:

```ts
  docsPage: {
    noProjects: 'У цьому воркспейсі немає проєктів.',
    pickProject: 'Оберіть проєкт, щоб побачити його документацію.',
    bindPrompt: "Прив'яжіть локальний репозиторій цього проєкту, щоб бачити документацію.",
    noFolders: 'Теки з документацією не налаштовано. Додайте їх у налаштуваннях проєкту.',
    pickFile: 'Оберіть файл ліворуч.',
    loading: 'Завантаження…',
    binary: 'Бінарний файл — прев\u2019ю недоступне.',
  },
```

`en/index.ts` (mirror) with the English equivalents.

- [ ] **Step 5: Verify typecheck**

Run (from `kermanych/apps/ui`): `pnpm exec vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/ui/src/pages/ProjectDocumentationPage.vue kermanych/apps/ui/src/router/routes.ts kermanych/apps/ui/src/layouts/MainLayout.vue kermanych/apps/ui/src/i18n/uk/index.ts kermanych/apps/ui/src/i18n/en/index.ts
git commit -m "feat(ui): Project Documentation screen + pull refresh"
```

---

### Task 15: Full verification + smoke test

**Files:**
- None (verification only).

- [ ] **Step 1: Run the affected suites**

```bash
cd kermanych
pnpm --filter @kermanych/cloud vitest run
pnpm --filter @kermanych/core vitest run
pnpm --filter api vitest run
pnpm --filter ui vitest run
```
Expected: all green (including the new specs from Tasks 2, 4, 6, 7, 10).

- [ ] **Step 2: Typecheck + lint once**

```bash
pnpm -r exec tsc --noEmit   # or the repo's typecheck script
pnpm lint                    # repo lint, once
```
Expected: clean.

- [ ] **Step 3: Browser-driven smoke test (the verification of record)**

Start the app (`pnpm dev:app`, or `pnpm dev:api` + `pnpm dev:ui`). Sign in. Then, driving the real UI:

1. Bind a project to a local git repo that contains a `docs/` folder with a markdown file (with a fenced code block and a relative `![](./img.png)`), then in **Settings → project → Git**, add `docs` under **Documentation folders** and save.
2. Open **Management → Project Documentation**. Confirm: the workspace's projects are listed; the bound project's `docs` folder expands; selecting the markdown file renders GitHub-faithfully — **no `<br>` from single newlines, a highlighted code block, and the relative image visible inline**.
3. Open a code file (e.g. a `.ts` sample) and confirm `highlight.js` rendering.
4. Change a doc file in the repo on disk / pull an update, press the sidebar **Pull** button, and confirm the open preview refreshes.
5. Select a project that is **not bound** on this machine and confirm the bind prompt appears (no file read attempted).

Capture the rendered-preview state as the evidence this feature works. Report explicitly if any step cannot be exercised.

- [ ] **Step 4: Final commit (if any lint/format fixups)**

```bash
git add -A
git commit -m "chore: docs preview lint/format fixups"
```

---

## Self-Review

**Spec coverage:**
- §3.1 data model → Tasks 1–5. §3.2 API → Tasks 6–8. §3.3 renderer → Task 10. §3.4 Settings editor → Task 13. §3.5 screen + section promotion → Tasks 11, 12, 14. §3.6 freshness (pull refresh) + option A (local-only, bind prompt) → Tasks 11, 14. §5 testing → Tasks 2/4/6/7/10 unit + Task 15 smoke. §6 i18n uk-first → Tasks 12, 13, 14.
- Out-of-scope items (no cloud snapshot, read-only, no watcher, no embedded raw HTML) are respected: no upload path exists; the section is `read`; refresh is pull-bound; `renderDoc` keeps `html:false`.

**Type consistency:** `docFolders: string[]` (`CloudProject`, `CloudProjectPatch`, `Project`, registry, controller/api bodies) is consistent everywhere. Supervisor `docsTree`/`docsFile`/`docsRaw` signatures match the api client (`projectDocsTree`/`projectDocsFile`/`projectDocsRaw`) and the routes. `renderDoc(src, { folder, dir })` / `resolveRel(dir, rel)` signatures match the page and the tests. `readFileBytes` return shape (`{ bytes, contentType } | null`) is consistent across service → supervisor → controller.

**Placeholder scan:** every code step carries real code; test steps include assertions. The one adaptive step (Task 7 test construction) points at the existing supervisor test harness to copy rather than leaving it vague, because the supervisor's constructor injects many deps and its exact shape must be read at implementation time.
