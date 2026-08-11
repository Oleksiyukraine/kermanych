# Per-project environment for sessions — design

Date: 2026-08-11
Status: approved (rev 2 — model W: in-app `.env` editor)

## Problem

A Kermanych session runs in an isolated git worktree (`git worktree add`), which
contains only tracked files. Gitignored, project-local secret files — chiefly
`.env` — are therefore absent from the session. Real projects need them: `.env`
holds a per-project GitHub PAT (`GITHUB_TOKEN`) that `gh` uses to open PRs (the
default `gh`/SSH identity lacks PR access on these repos), plus build-time
secrets the app needs to compile and run. Verified: a `git worktree add` of a
real repo yields a worktree with the tracked `.npmrc` present but `.env` absent.

Two needs:

1. Sessions must receive the project's secret files.
2. Configuring those secrets must be discoverable IN-APP — a person handed
   Kermanych should not have to know to hand-place a `.env` in the project dir.

Push/clone auth is out of scope — it already works via SSH host-aliases in
`remote.origin.url` + keychain, inherited by worktrees (verified).

## Approach (model W): in-app editor of the project's `.env`

The project's `.env` on disk stays the single source of truth. Kermanych does
NOT store secret values in its own DB. It (a) copies the declared files into each
session worktree, and (b) provides a Project Settings → Environment panel that
reads and safely rewrites `projectDir/.env`, so secrets are configured in-app.

### Filesystem access — not a new permission surface

Kermanych already reads and writes the filesystem as the user: `git worktree add`
creates worktree trees; `commitAll`/`checkout`/`merge` mutate the project tree;
the directory picker (`fs.controller.ts`) reads dirs; the registry creates
`~/.kermanych` and its SQLite; the copy step already writes `.env` into worktrees.
Editing one file (`.env`) inside a directory the user explicitly connected is the
same trust boundary. The write happens server-side in the Node API — the browser
is sandboxed and never touches the FS; it POSTs values to the local API, exactly
like the existing directory picker. On macOS the terminal that launches Kermanych
needs access to the project location (e.g. `~/Documents`); this grant already
exists in practice — `git worktree add` on the real repos under `~/Documents/...`
already succeeds. The real concern is not permission but writing the file WITHOUT
corrupting it.

## Requirements

1. `carryFiles: string[]` per group (default `[".env"]`): files copied into each
   worktree session at creation (unchanged from rev 1).
2. Project Settings → Environment panel edits `projectDir/.env`: list keys,
   add/edit/remove, values masked with per-key reveal.
3. Writes are safe: per-key surgical update preserving comments, blank lines, and
   key order; values that need it are quoted (so a POSIX `source .env` cannot
   break on `&`, spaces, etc.); atomic write (temp file + `rename`); the file is
   created if missing.
4. Writes are path-confined: the target resolves to a path inside `projectDir`;
   traversal (`..`) or absolute escapes are rejected.
5. If `.env` is not gitignored, the API returns a warning (it does not auto-edit
   `.gitignore`).
6. Kermanych stores no secret values; the file is canonical.
7. Copy step, in-place skip, no-commit guarantee, and teardown are unchanged from
   rev 1.

## Data model

`carryFiles: string[]` on `Group` (`packages/core/src/types.ts`), default
`[".env"]`, stored in SQLite via additive migration
`ALTER TABLE groups ADD COLUMN carry_files TEXT NOT NULL DEFAULT '[".env"]'`
(JSON array; the column default backfills existing groups). `listGroups` parses
it; `createGroup`/`updateGroup` persist it. No env VALUES are stored in the
registry — they live only in `projectDir/.env`.

## Env file service

New `EnvFileService` (api) — pure fs plus a small dotenv parse/serialize:

- `read(projectDir, file = ".env")`: parse into ordered `{ key, value }[]`,
  preserving unrelated lines for round-trip. Returns `{ entries, ignored }` where
  `ignored` reflects `git check-ignore <file>`.
- `write(projectDir, file, { set, remove })`: load current text (or empty),
  update `KEY=value` lines in place, append new keys, drop removed keys, preserve
  comments/blank lines/order; quote a value containing whitespace or any of
  `# & $ " '` or a newline; write to `<file>.tmp` then `rename` over the target.
- Path guard: `base = resolve(projectDir)`, `target = resolve(projectDir, file)`;
  reject unless `target === base || target.startsWith(base + sep)`, so `..` and
  absolute paths cannot escape `projectDir`.

## Copy step

Unchanged from rev 1. In `SupervisorService.createSession` (worktree branch
only), immediately after `worktree.addWorktree(projectDir, wtDir, branch)`
succeeds and before the omp child spawns, copy each existing `group.carryFiles`
entry from `projectDir` into `wtDir` at the same relative path (missing → skip).
On a copy error, remove the just-created worktree + branch and rethrow so
`createSession`'s existing failure handling removes the session row. No orphan.

## API

- `GET /groups/:id/env?file=.env` → `{ entries: {key,value}[], ignored }`. Values
  are returned raw for the user's own local file over localhost; the UI masks by
  default with per-key reveal. Resolves the group, delegates to
  `EnvFileService.read`.
- `PUT /groups/:id/env` → body `{ file?: string; set?: Record<string,string>;
  remove?: string[] }` → `EnvFileService.write`, returns the refreshed list.
- `carryFiles` remains settable via `POST /groups` and `PATCH /groups/:id`.

## UI

- Entry point: a gear affordance on the selected project (in `MainLayout.vue`
  header `shell__context`, or on `KRailItem`) opening a Project Settings modal.
- `KModal` "Налаштування проєкту" with an **Environment** section:
  - rows: key (`KField`) + masked value (`KField`, password) + reveal toggle +
    remove; an "Додати змінну" button; "Зберегти" persists via
    `store.saveEnv(id, { set, remove })`.
  - note: «Значення зберігаються у `.env` проєкту; Керманич їх у себе не тримає.
    У git файл не потрапляє.»; if `!ignored`, an inline warning.
  - advanced: the `carryFiles` list (default `.env`), editable.
- `lib/api.ts`: `getEnv(id)`, `saveEnv(id, patch)`; `stores/orchestrator.ts`
  actions forwarding them.
- New-Project modal stays name + dir only; env is configured in settings after
  creation.

## Verification

- `env-file.spec.ts`: round-trip preserves comments/order; update an existing
  key; add a new key; remove a key; a value with `&`/spaces is quoted so a POSIX
  `source` parses it; atomic write leaves no partial file on a simulated
  mid-write failure; the path guard rejects `../escape` and absolute paths.
- `registry.spec.ts`: `carryFiles` default `[".env"]`, custom persist via
  `updateGroup`, JSON parse via `listGroups`, migration backfill (rev 1).
- Smoke: connect `platinum-os`; open Project Settings → Environment → keys listed
  (masked); add `KMQ_TEST=1`; confirm it is appended to the real
  `platinum-os/.env` with the other vars and comments intact; create a worktree
  session → `.env` present in the worktree; inside it
  `export GH_TOKEN=$(sed -n 's/^GITHUB_TOKEN=//p' .env) && gh repo view <owner/repo>`
  works; remove `KMQ_TEST` via the UI → gone from the file.

## Non-goals

- Kermanych does not store secret values (that is model X); canonical = the file.
- No auto-editing of `.gitignore` (warn only).
- No named "Integrations" veneer in v1 — the env editor is the substrate; a
  GitHub integration can wrap it later.
- No symlink mode; no clone-by-URL; no separate Push/PR feature (the agent pushes
  and opens PRs via the project's own release flow: SSH + `GH_TOKEN=$GITHUB_TOKEN
  gh`).
- Editing files outside `projectDir` is rejected.
- In-place (non-worktree) sessions run in `projectDir` with its own `.env`;
  unchanged.
