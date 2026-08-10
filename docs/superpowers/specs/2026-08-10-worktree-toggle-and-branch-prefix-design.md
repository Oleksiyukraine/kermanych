# Kermanych — Worktree Toggle & Branch Prefix (Design)

- **Status:** Draft for review
- **Date:** 2026-08-10
- **Scope:** `apps/ui` (WorkspacePage launcher, lib/api, store, a new `KCheckbox`),
  `apps/api` (supervisor, worktree, preview, registry, sessions controller),
  `packages/core` (types, worktree-names)

## 1. Purpose

When launching a new agent, let the operator choose two things the launcher
does not expose today:

1. **Isolation mode** — a checkbox **"Ізолювати у worktree"**, **on by
   default**. On → current behavior (a dedicated git worktree). Off →
   **in-place**: the agent runs directly in the project directory on a freshly
   created branch.
2. **Branch prefix** — one of `feature` / `fix` / `refactoring` / `chore`
   (default `feature`). The session branch becomes `<prefix>/<slug>` instead of
   the fixed `kermanych/<slug>`.

## 2. Current state (as-is)

- Branch name is always `kermanych/<slug>` (`packages/core/worktree-names.ts`
  → `branchName`). `<slug>` comes from `slugify(name)`, de-duplicated by
  `uniqueSlug` against existing session branches with the hard-coded
  `kermanych/` prefix stripped (`supervisor.createSession`).
- Every session = one git worktree at `~/.kermanych/worktrees/<sessionId>` plus
  one `omp --mode rpc` child with `cwd = worktreePath`. `git worktree add <dir>
  -b <branch>` creates worktree **and** branch; the project dir's HEAD is never
  touched.
- `worktreePath` is the cwd/anchor for **resume** (`doResume`), **preview**
  (`preview.start`), **editor** (`openInEditor`), **finish/merge**
  (`finishInfo`, `finishSession`), **conflict resolution** (`resolveConflict`),
  and **delete** (`deleteSession`). All of these currently throw "session has no
  worktree" when `worktreePath` is empty.
- Registry persists sessions in SQLite. Additive-migration precedent exists
  (`archived` column, wrapped in `try/catch`). `Session` has no isolation flag
  or base-branch field.
- Kit has `KToggle` (segmented control) and `KModal`/`KField`; there is **no**
  checkbox component yet.

## 3. Design

### 3.1 Branch prefix (both modes)

- `packages/core`: add
  `export const BRANCH_PREFIXES = ['feature','fix','refactoring','chore'] as const;`
  and `export type BranchPrefix = typeof BRANCH_PREFIXES[number];`.
- `branchName(slug, prefix)` → `` `${prefix}/${slug}` ``, with default param
  `prefix: BranchPrefix = 'feature'`.
- **De-dup fix:** `supervisor.createSession` today strips a hard-coded
  `kermanych/`. Replace with de-dup over **full branch names**: build
  `existing = new Set(sessions.map(s => s.branch))`, then bump the candidate
  `<prefix>/<slug>` (`-2`, `-3`, …) until unique. This keeps `feature/x`,
  `feature/x-2`, … unique per group and prevents collisions across prefixes.
  `uniqueSlug` is generalized (or a small `uniqueBranch(base, existing)` helper
  added) to operate on the full branch string.
- Server validates `prefix`: an unknown value → 400. Default `feature` when
  omitted.

### 3.2 Data model (additive migration)

- `Session` (`packages/core/types.ts`): add
  - `worktree: boolean` — `true` = isolated worktree, `false` = in-place.
  - `baseBranch?: string` — the project branch to return to after an in-place
    finish/delete; set only for in-place sessions.
- Registry migrations (existing try/catch pattern):
  `ALTER TABLE sessions ADD COLUMN worktree INTEGER NOT NULL DEFAULT 1` and
  `ADD COLUMN base_branch TEXT`.
- `listSessions` selects and maps `worktree` (0/1 → boolean) and `baseBranch`.
  `createSession`/`updateSession` include both columns. `createSession`
  **defaults `worktree` to `true`** and `baseBranch` to `null` when omitted, so
  existing callers/tests remain valid without change.

### 3.3 API surface

- `POST /sessions` body gains `worktree?: boolean` (default `true`) and
  `prefix?: BranchPrefix` (default `feature`). `SessionsController.create`
  forwards them.
- `SupervisorService.createSession` signature is extended to carry the two new
  options (grouped into the existing option set alongside `model`/`images`).
- UI `api.createSession` and `store.createSession` gain `worktree`/`prefix`
  arguments; `WorkspacePage.submitLauncher` passes the launcher state.

### 3.4 Worktree service (in-place primitives)

Add two thin git wrappers (reusing the private `git()` helper):

- `checkout(dir, ref, { force? })` → `git checkout [-f] <ref>`.
- `createBranchHere(dir, branch)` → `git checkout -b <branch>` (creates and
  switches inside `dir`).

Existing `hasUncommitted`, `currentBranch`, `commitAll`, `mergeBranch`,
`mergeInto`, `unmergedFiles`, `removeBranch` are reused unchanged.

### 3.5 Supervisor lifecycle

Introduce one anchor helper: `sessionDir(s, group) = s.worktreePath ||
group.projectDir` (in-place stores `worktreePath = ""`). Every worktree-anchored
path below routes through it.

**createSession:**

- Compute `branch = <prefix>/<slug>` (§3.1). Persist the row with `worktree`
  and, for in-place, `baseBranch`.
- **worktree === true:** unchanged — `addWorktree(projectDir, wtDir, branch)`,
  `worktreePath = wtDir`, `omp` cwd = `wtDir`.
- **worktree === false (in-place):** guards, then run:
  - Refuse (400) if `projectDir` is dirty (`hasUncommitted`).
  - Refuse (400) if any existing session in the group has `worktree === false`
    and `status !== 'merged'` — exactly one live in-place agent may occupy the
    project dir at a time.
  - `baseBranch = currentBranch(projectDir)`; refuse (400) if empty (detached
    HEAD).
  - `createBranchHere(projectDir, branch)`; `worktreePath = ""`; `omp`
    cwd = `projectDir`.
  - On `omp` start failure, roll back:
    `checkout(projectDir, baseBranch, { force: true })` then
    `removeBranch(projectDir, branch)`.

**doResume (after an api restart):** cwd = `sessionDir(s, group)`. For in-place,
additionally guard `currentBranch(projectDir) === s.branch`; otherwise throw
"project is not on this session's branch — switch to it or delete the agent"
(resuming would operate on the wrong tree).

**preview.start / openInEditor / resolveConflict:** use `sessionDir(s, group)`
instead of requiring `worktreePath`. Preview already resolves the group;
editor/resolve resolve the group to reach `projectDir`.

**finishInfo:**

- worktree: unchanged.
- in-place: `target = s.baseBranch`; `ahead = aheadCount(projectDir, base,
  branch)`; `dirty = hasUncommitted(projectDir)`;
  `conflicts = unmergedFiles(projectDir)`.

**finishSession** (in-place, where projectDir is currently on `s.branch`):

- Guard `currentBranch(projectDir) === s.branch`, else error.
- If `unmergedFiles(projectDir)` is non-empty → "resolve conflicts first".
- Commit dirty work (`commitAll`).
- `checkout(projectDir, base)`; then `mergeBranch(projectDir, branch, msg)`:
  - **success:** `removeBranch(projectDir, branch)`; stop `omp`; status
    `merged` (`worktreePath` already ""); project left on `base`. Return
    `{ merged, into: base }`.
  - **conflict:** `mergeBranch` has already aborted (base left clean);
    `checkout(projectDir, branch)` (back onto the session branch);
    `mergeInto(projectDir, base)` to leave markers **on the branch** in
    projectDir; status `conflict`; return `{ conflict, files }`. This mirrors
    worktree semantics (resolution happens on the session branch), so re-running
    finish after the resolve merges cleanly and deletes the branch.

**deleteSession:**

- worktree: unchanged (`removeWorktree` + `removeBranch`).
- in-place: stop `omp`; if `currentBranch(projectDir) === s.branch` →
  `checkout(projectDir, base)` (fallback `-f`, since delete discards the
  session's in-progress work), then `removeBranch(projectDir, branch)` (force
  `-D`). If projectDir is already on another branch, just `removeBranch`.

### 3.6 UI (launcher modal, `WorkspacePage.vue`)

- New reactive state: `draftPrefix = ref<BranchPrefix>('feature')`,
  `draftWorktree = ref(true)`; both reset in `openLauncher`.
- **Prefix row:** label "Префікс гілки" + `KToggle` with the four options.
- **Worktree row:** a labeled checkbox "Ізолювати у worktree" (default checked).
  Add a minimal `KCheckbox` kit component — a native `<input type="checkbox">`
  styled to design tokens (radius 0, accent), a pure presenter
  (`modelValue`/`update:modelValue` + a label). There is no checkbox in the kit
  today.
- When unchecked, show a muted hint: in-place runs in the project directory on
  `<prefix>/<slug>`; the project tree must be clean and only one in-place agent
  runs at a time.
- Optional nicety: show the computed `<prefix>/<name-slug>` preview under the
  fields.
- `submitLauncher` passes `draftWorktree.value` and `draftPrefix.value` through.
- Server-side errors (dirty tree / in-place already active / detached HEAD)
  surface through the existing `launcherError` catch — the launcher stays open
  with the reason.

## 4. Isolation / boundaries

- **`packages/core`** — pure naming + types: `BRANCH_PREFIXES`, `BranchPrefix`,
  `branchName(slug, prefix)`, `Session.worktree`/`baseBranch`. No behavior.
- **`WorktreeService`** — stateless git wrappers; adds `checkout`,
  `createBranchHere`. No session knowledge.
- **`SupervisorService`** — the only place that decides worktree-vs-in-place and
  owns lifecycle; funnels every anchor through `sessionDir`.
- **`RegistryService`** — persistence only; two additive columns.
- **`PreviewService`** — anchor via `sessionDir`; otherwise unchanged.
- **UI** — launcher gains two controls + a presenter `KCheckbox`; store/api just
  forward the new fields.

## 5. Verification

**Unit (vitest, `apps/api` + `packages/core`):**

- `branchName('x','fix')` → `fix/x`; default prefix → `feature/x`.
- De-dup: two sessions named alike under the same prefix yield `feature/x`,
  `feature/x-2`; different prefixes do not collide.
- Registry round-trip: `createSession` defaults `worktree` to `true`; an
  explicit `worktree:false` + `baseBranch` persists and reads back (0/1 → bool).
- In-place finish (extend `finish.spec.ts`, which already drives a real temp
  repo): `createBranchHere` in the repo, mutate + commit, `finishSession` merges
  into base, deletes the branch, status `merged`, project left on `base` with
  the work landed.
- In-place finish conflict: divergent base vs branch → `finishSession` returns
  `{ conflict }` with the file, project sits on the session branch with markers,
  base untouched; after resolving + committing, a second `finishSession` merges
  clean and deletes the branch.
- In-place create guards: dirty projectDir → throws; a second in-place create
  while one is live → throws.

**Smoke (manual):** `pnpm dev:api` + `pnpm dev:ui`:

- Default launch (checkbox on) → agent runs in a worktree; branch tag shows
  `feature/<slug>`; switching the prefix changes the tag.
- Uncheck worktree in a clean repo → agent runs in-place;
  `git -C <projectDir> branch --show-current` = `<prefix>/<slug>`;
  editor/preview open the project dir; finish merges into the base branch and
  restores it.
- Uncheck worktree in a dirty repo → launcher shows the "tree must be clean"
  error; nothing is created.

## 6. Non-goals

- Configurable/custom prefixes beyond the four (the list is fixed).
- Running multiple concurrent in-place agents in one project dir (explicitly one
  at a time).
- Auto-stashing the operator's uncommitted work to enable in-place on a dirty
  tree (we refuse instead).
- Changing worktree-mode behavior, the RPC surface, or the
  `~/.kermanych/worktrees/<id>` layout.
