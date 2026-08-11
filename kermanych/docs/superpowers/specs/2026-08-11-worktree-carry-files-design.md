# Per-project carry files (session worktree secrets) — design

Date: 2026-08-11
Status: approved

## Problem

A Kermanych session runs in an isolated git worktree created with
`git worktree add`. A fresh worktree contains only tracked files, so gitignored,
project-local secret files — chiefly `.env` — are absent from the session. Real
projects depend on those files: they hold a per-project GitHub PAT
(`GITHUB_TOKEN`) that `gh` needs to create PRs (the default `gh`/SSH identity
lacks PR access on these repos), plus build-time secrets the app needs to
compile and run. Verified against a real repo: a `git worktree add` yields a
worktree with the tracked `.npmrc` present but `.env` absent.

Push/clone auth is NOT the gap — it already works. Each project's account is
selected by an SSH host-alias baked into `remote.origin.url` (`~/.ssh/config` +
keychain), and a worktree inherits both that remote and the local commit
identity (`user.name`/`user.email`) from the shared repo config (verified). The
only missing piece is getting the project's untracked secret files into the
worktree. The existing omp workflow already does this manually (a repo `/start`
command "copies `.env` into" the worktree); Kermanych builds its own worktree
and skips that step.

## Assumptions

The Kermanych API is launched from the user's interactive session, so git/omp
child processes inherit `SSH_AUTH_SOCK` and macOS keychain access — SSH push
resolves the right key without any Kermanych involvement (verified: `ssh -T` to
both per-account aliases authenticated as the expected principals from this
environment). No code addresses SSH auth.

## Requirements

1. Each project (group) declares a list of files to carry into every worktree
   session. Default: `[".env"]`.
2. On worktree-session creation, Kermanych copies each declared file that exists
   in `projectDir` into the new worktree at the same relative path, BEFORE the
   omp child starts.
3. A declared file that does not exist is skipped silently (default `.env` may
   be absent in some projects).
4. A declared file that exists but fails to copy aborts session creation with a
   surfaced error and leaves no orphan worktree/branch.
5. In-place (non-worktree) sessions do not copy — they run in `projectDir`,
   which already holds the files.
6. Carried secrets are never committed: the worktree's tracked `.gitignore`
   already ignores them; Kermanych neither adds nor tracks them.
7. Kermanych stores no token/credential itself — it only copies files that
   already live in the project. Copies are removed with the worktree when the
   session is deleted.

## Data model

`carryFiles: string[]` on `Group` (`packages/core/src/types.ts`), default
`[".env"]`.

SQLite (`registry.service.ts`): additive migration mirroring the existing
guarded `ALTER TABLE … ADD COLUMN` pattern —
`ALTER TABLE groups ADD COLUMN carry_files TEXT NOT NULL DEFAULT '[".env"]'`.
The column default backfills pre-existing groups. Value is a JSON array string.

- `listGroups`: select `carry_files` and `JSON.parse` it into `carryFiles`
  (a post-query map, not a plain column alias like the other fields).
- `createGroup`: INSERT `carry_files = JSON.stringify(g.carryFiles ?? [".env"])`
  (the INSERT currently omits optional group columns; carry_files is written so
  a provided list persists and the code-level default is explicit).
- `updateGroup`: patch may include `carryFiles`; persist
  `JSON.stringify(next.carryFiles)` alongside the existing columns.

## Copy step

`SupervisorService.createSession` (`supervisor.service.ts`), worktree branch
only. Immediately after `worktree.addWorktree(projectDir, wtDir, branch)`
succeeds and before the omp child spawns:

- New private helper `copyCarryFiles(projectDir, wtDir, files)` using
  `node:fs`/`node:fs/promises`: for each `f`, `src = join(projectDir, f)`; if
  `existsSync(src)`, `mkdir(dirname(join(wtDir, f)), { recursive: true })` then
  `copyFile(src, join(wtDir, f))`. A missing `src` is skipped.
- On any copy error, remove the just-created worktree + branch
  (`worktree.removeWorktree` + `worktree.removeBranch`) and rethrow, so
  `createSession`'s existing failure handling surfaces the error and removes the
  session row. No orphan worktree/branch/row.

`group.carryFiles` comes from the group already fetched at the top of
`createSession`.

## API

- `POST /groups` (`groups.controller.ts`): body gains optional
  `carryFiles?: string[]`, forwarded to `supervisor.addGroup`.
- `PATCH /groups/:id`: body gains optional `carryFiles?: string[]`, forwarded to
  `supervisor.updateGroup`.
- `SupervisorService.addGroup(name, projectDir, carryFiles?)` →
  `registry.createGroup({ name, projectDir, carryFiles })`.
- `SupervisorService.updateGroup(id, patch)` patch type gains `carryFiles?`.

## UI

- `lib/api.ts`: `createGroup(name, projectDir, carryFiles?)` posts `carryFiles`;
  `updateGroup` patch type gains `carryFiles?: string[]`.
- `stores/orchestrator.ts`: `createGroup` / `updateGroup` forward `carryFiles`.
- `layouts/MainLayout.vue` New-Project modal: add a "Файли для сесії" textarea,
  prefilled `.env`, one path per line. On submit, parse non-empty trimmed lines
  into `carryFiles` and pass to `store.createGroup`; empty input → `[".env"]`.

## Verification

- `registry.spec.ts`: a new group defaults to `carryFiles === [".env"]`;
  `updateGroup` persists a custom list; `listGroups` returns the parsed array;
  the migration backfills an existing row to `[".env"]`.
- Copy-helper unit test: a temp `projectDir` with `.env`, a nested `config/svc`,
  and one missing entry; assert existing files land in `wtDir` at the same
  relative path and the missing one is skipped.
- Smoke: connect a real repo (e.g. `platinum-os`) as a project (default `.env`);
  create a worktree session; confirm `~/.kermanych/worktrees/<id>/.env` exists;
  inside the session shell
  `export GH_TOKEN=$(sed -n 's/^GITHUB_TOKEN=//p' .env) && gh repo view <owner/repo>`
  succeeds; delete the session → the worktree and its `.env` copy are gone.

## Non-goals

- No credential/token storage, parsing, or env injection by Kermanych — it
  copies files only; the agent reads `.env` itself.
- No separate Push/PR feature — the agent pushes and opens PRs via the project's
  own release flow (SSH + `GH_TOKEN=$GITHUB_TOKEN gh`).
- No clone-by-URL / remote management.
- No symlink mode (copy only).
- No dedicated edit-carryFiles UI for existing groups in v1; `PATCH /groups/:id`
  accepts `carryFiles` for later/manual edits, and new projects set it at
  creation.
- Carry lists are meant for untracked/ignored files; listing a tracked file
  would surface as a worktree modification (not guarded in v1).
