# Kermanych

Kermanych is a local, project-grouped orchestrator for running multiple
`omp` coding sessions in parallel. It is a NestJS API plus a
Quasar (Vue 3) UI. Each session gets its own git worktree and its own
`omp --mode rpc` child process, so several agents can work in isolation at the
same time and you drive them all from one board.

- **API** — NestJS. Manages sessions, git worktrees, the SQLite registry, and
  the RPC bridge to each `omp` child. Speaks REST + WebSocket.
- **UI** — Quasar/Vue 3. A single dashboard for creating sessions, watching
  their turns stream in, and answering interactive prompts.
- **One session = one git worktree + one `omp --mode rpc` child.** Worktrees
  live under `~/.kermanych/worktrees/<sessionId>`; the registry DB is
  `~/.kermanych/kermanych.sqlite`.

## Prerequisites

- **Node ≥22.12** — REQUIRED. `better-sqlite3` is pinned to v13, whose N-API
  prebuilt binary is ABI-stable across Node ≥22.12 and the bundled Electron, so
  no per-version rebuild is needed. Older Node (including 22.11) crashes the
  native addon.
- **`omp` on your PATH, authenticated.** Each session spawns
  `omp --mode rpc`; if `omp` is missing or unauthenticated, sessions cannot
  start.
- **pnpm** (the repo pins its version via `packageManager` in
  `package.json`).

## The shared board (cloud)

Kermanych's task board is shared through Supabase (auth, projects, membership,
tasks, Realtime). Execution stays local — worktrees, `omp` children and
transcripts never leave your machine — but signing in and seeing the board go
through the team's Supabase project.

### Start here (no configuration)

```bash
git clone <repo> && cd kermanych
pnpm install
pnpm dev:app          # desktop app; hosts the API in-process
```

Then press **Увійти через GitHub**. That is the whole setup: **there are no
environment variables to set and no `.env` to create.** The team's Supabase
project is compiled into `packages/cloud` as `DEFAULT_CLOUD`, and both the API
and the UI fall back to it.

`pnpm dev:app` starts the API **in-process**, so one shell is enough — no second
terminal, no `pnpm dev:api`. (In a browser instead of the desktop window, run
`pnpm dev:api` and `pnpm dev:ui` in two terminals; see [Setup & run](#setup--run).)

**Sign-in is open:** any GitHub account can sign in. The first sign-in creates
your account and an empty, private workspace — you see only projects you own or
are invited to as a member, and nobody sees yours until you invite them. There is
no allowlist to manage.

**Membership is by email.** In a project's settings, any member can invite a
colleague by the email address their account signed in with; the invited person
joins as `member` immediately. There are no pending invitations: the address must
already belong to an account, so ask a newcomer to press **Увійти через GitHub**
once before you invite them. Removing a member stays the project owner's call.

You do **not** need `GITHUB_SECRET` either. The hosted project holds the team's
GitHub OAuth credentials in the Supabase dashboard; nobody has to send them to
you.

### Why the backend is in the repository

The project URL and the publishable key are **public application configuration**,
not credentials, so they are committed:

| value | classification | where it lives |
|---|---|---|
| project URL | public | `DEFAULT_CLOUD` in `packages/cloud/src/client.ts` |
| `Publishable key` (`sb_publishable_…`, formerly `anon`) | public — shipped inside the browser bundle by design | same |
| `GITHUB_CLIENT_ID` | public | Supabase dashboard (hosted), `.env` (local stack only) |
| `GITHUB_SECRET` | **secret** — the only real one in this repo | Supabase dashboard (hosted), your own `.env` (local stack only) |
| `Secret key` (`sb_secret_…`, formerly `service_role`) | **secret** — never used by Kermanych | the dashboard, and nowhere else |

What protects the project is not the obscurity of those two values but **RLS**,
verified against the live project: an anonymous read of any table is refused with
`42501 permission denied`, and per-project policies isolate each user to the
projects they own or are a member of. Sign-in is open, so RLS is the sole
authorization surface — every request runs under the user's own JWT. **No secret
key ever belongs on a machine running Kermanych**, and nothing in this repo reads
one.

### Running against a local stack or your own project

Everything below is for pointing Kermanych somewhere OTHER than the team's
project — a local Supabase stack or your own fork. Skip it otherwise.

A local stack needs Docker and the
[Supabase CLI](https://supabase.com/docs/guides/local-development):

```bash
supabase start        # from the repo root; prints the API URL and the local keys
supabase db reset     # apply supabase/migrations/*.sql to a clean database
supabase status       # re-print the URLs and keys at any time
```

This repo's `supabase/config.toml` pins the local stack to the **544xx** band
(API `http://127.0.0.1:54421`, database `postgresql://postgres:postgres@127.0.0.1:54422/postgres`),
not the CLI's default 543xx, so it can coexist with another Supabase project on
the same machine. Every URL below uses those ports.

**GitHub OAuth App** — GitHub allows one callback URL per app, so a local stack
and a hosted project need one each (<https://github.com/settings/developers>).
Create your OWN throwaway app; never reuse the team's:

| target | Authorization callback URL |
|---|---|
| local stack | `http://127.0.0.1:54421/auth/v1/callback` |
| hosted project | `https://<project-ref>.supabase.co/auth/v1/callback` |

For the local stack, put the app's credentials in `kermanych/.env` (copy
`.env.example`) or export them **before** `supabase start` — `supabase/config.toml`
substitutes them into `[auth.external.github]` under exactly these names:

```bash
export GITHUB_CLIENT_ID=Ov23li…
export GITHUB_SECRET=ghs_…
```

For your own hosted project, set the same pair under Authentication → Providers →
GitHub, and add both redirect URLs (`http://localhost:5317/**` and
`http://127.0.0.1:53170/callback`) under Authentication → URL Configuration.
The second one is the fixed loopback the desktop app listens on.

**Two consumers, two spellings** — the API and the UI each need the same URL and
the same public API key under different names, because Vite only inlines
`VITE_`-prefixed variables:

| variable | consumer | value |
|---|---|---|
| `SUPABASE_URL` | `apps/api` | the API URL |
| `SUPABASE_PUBLISHABLE_KEY` | `apps/api` | the publishable key |
| `SUPABASE_ANON_KEY` | `apps/api` | legacy name for the same value, still accepted |
| `VITE_SUPABASE_URL` | `apps/ui` | the same API URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `apps/ui` | the same publishable key |
| `VITE_SUPABASE_ANON_KEY` | `apps/ui` | legacy name for the same value, still accepted |

Export the api pair in the shell that runs `pnpm dev:api` (or `pnpm dev:app`,
which hosts the API in-process), and put the ui pair in `apps/ui/.env` (copy
`apps/ui/.env.example`; the real file is gitignored):

```bash
# apps/ui/.env — public values only, not committed
VITE_SUPABASE_URL=http://127.0.0.1:54421
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   # or VITE_SUPABASE_ANON_KEY=<anon key>
```

**Set both halves of a pair, or neither.** With neither, the built-in default is
used. With exactly one, startup fails on purpose rather than mixing a custom URL
with the team's key: `cloud env missing: set SUPABASE_PUBLISHABLE_KEY (or the
legacy SUPABASE_ANON_KEY) too, or unset SUPABASE_URL to use the built-in
default`. Point both consumers at the same backend, or the board the UI reads
will not be the board the API writes.

Set one key name per consumer — whichever format your backend hands you. If both
are set, the publishable one wins.

**Expect both key shapes on the same machine, and do not try to unify them.** A
hosted dashboard offers only the new format (`Publishable key` / `Secret key`).
The local CLI stack keeps issuing the LEGACY JWTs: `supabase status` on a recent
CLI prints `ANON_KEY` and `SERVICE_ROLE_KEY` (the fixed local demo JWTs) next to
a `PUBLISHABLE_KEY` / `SECRET_KEY` pair, and an older CLI prints only the legacy
two. So a developer who works locally AND against the hosted project rightly has
an `eyJ…` anon JWT for one and an `sb_publishable_…` key for the other — same
public role, two formats, neither more correct than the other. Kermanych takes
either value under either variable name, so nothing has to be converted.

### Running the cloud tests

`packages/cloud`'s unit suite needs nothing. Its RLS/trigger integration suite is
skipped unless all three of these are set. They are LOCAL-STACK fixtures and keep
the legacy CLI spelling on purpose — that is what `supabase status` labels them —
and `SUPABASE_TEST_SERVICE_KEY` is a *test fixture only*: it mints throwaway
users through the admin API on your own local stack, is never read by shipped
code, and must never hold a hosted project's secret key. `SUPABASE_TEST_ANON_KEY`
takes either format — the suite passes with the local stack's `PUBLISHABLE_KEY`
in it just as it does with `ANON_KEY`:

```bash
supabase start && supabase db reset
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY=<anon key>
export SUPABASE_TEST_SERVICE_KEY=<service_role key>
pnpm --filter @kermanych/cloud test
```

The suite mints its own users through the Supabase admin API (the service-role
key) — the same provisioning path GitHub OAuth drives — so it needs no `psql` and
no seeding. Every assertion still runs through a public-key client under a real
user JWT, exactly like the shipped app.

## Setup & run

```bash
pnpm install          # install all workspace deps

pnpm dev:api          # NestJS API on http://localhost:4317
pnpm dev:ui           # Quasar UI on  http://localhost:5317
```

Run the two dev commands in separate terminals, then open
<http://localhost:5317> in your browser. The UI talks to the API on `:4317`.

> **Note:** `better-sqlite3` v13 ships an N-API prebuilt binary, so switching
> Node versions (≥22.12) needs no rebuild.

## Desktop app (macOS)

Kermanych also runs as a desktop app (Electron via Quasar): one window that
starts the API in-process — no browser, no separate dev servers.

```bash
pnpm dev:app      # run the desktop app in dev
pnpm build:app    # build a macOS .dmg (unsigned)
```

The build is **unsigned**, so on first open macOS Gatekeeper blocks it. Open it
with **right-click → Open** (once), or clear the quarantine flag:

```bash
xattr -cr /Applications/Kermanych.app
```

Native module note: `better-sqlite3` is pinned to v13 (N-API); one prebuilt
binary works under both the Node (≥22.12) and Electron ABIs, so no rebuild.

## Monorepo layout

pnpm workspaces (`packages/*`, `apps/*`):

- **`packages/core`** — framework-agnostic domain logic: worktrees, the
  SQLite registry, RPC frame handling, session status. Unit-tested with
  vitest.
- **`packages/cloud`** — the Supabase client and the typed cloud surface
  (auth, projects, membership, tasks, Realtime) shared by the API and the UI.
  Its RLS/trigger suite runs against a real local stack; see above.
- **`packages/tokens`** — the design tokens (colors, spacing, type) shared by
  the UI, generated from the design system.
- **`apps/api`** — the NestJS application: REST + WebSocket surface, session
  supervision, and the `omp` RPC bridge.
- **`apps/ui`** — the Quasar/Vue 3 dashboard.

## Design

The visual source of truth lives in [`design/`](./design/):

- `design/design-system.html` — the rendered design system (colors, type,
  components). Open it in a browser.
- `design/design-v01.html` — an earlier full-screen design reference.
- `design/icon-prompt.svg` — the app-icon mark ("Промпт"): a `>` prompt
  chevron plus an input cursor. Regenerate the whole favicon/Electron icon
  set from it with `python3 scripts/gen-icons.py` (stdlib only; the macOS
  `.icns` step needs `iconutil`).

Custom `K*` components implement this look; Quasar is used only for the
framework, layout, build, and state plumbing.

## Cloud tasks and local sessions

A **task** is a card in the shared cloud board; a **session** is its execution on one
developer's machine. The direction is always task → session.

1. **Create** — any member of a project creates a task on the board (`/#/board`) with a
   title, a description and optional launch params (model, branch prefix, platform, base
   branch). It starts in `backlog`, which exists only in the cloud.
2. **Assign** — the author assigns it to a member, or a member presses «Запустити» on an
   unassigned task, which self-assigns it atomically. Only the assignee can run it; an
   active task (`queued`, `thinking`, `tool`, `waiting_input`) can be neither reassigned
   nor deleted.
3. **Bind** — a cloud project has no idea where its repo lives on your disk. The first
   «Запустити» for an unbound project asks for the local git repository and stores that
   path locally (it never reaches the cloud).
4. **Run** — `POST /api/sessions/from-task` creates a git worktree under
   `~/.kermanych/worktrees/<sessionId>`, copies the project's `carryFiles` (`.env` by
   default) into it, and spawns one `omp --mode rpc` child. From here on the session is an
   ordinary local session: it appears on the workspace board and you drive it there.
5. **Status flows back** — the local API mirrors the session's coarse status
   (`queued → thinking → tool → waiting_input → done | error | stopped | merged |
   conflict`) to the task, and everyone's board updates live over Supabase Realtime.

Nothing else leaves your machine. Transcripts, the current tool, context usage, todo
phases and interactive prompts are local-only by design — the board shows THAT a task
waits for input, and only its owner can answer it, on their own machine.

### Offline behaviour

Local work never waits for the cloud:

- A session that already exists keeps running, answering, merging and finishing with no
  network at all — the local `projects` row caches the project config, so nothing on
  that path reads the cloud.
- STARTING a board task is the one step that needs the cloud: Kermanych has to read the
  task and claim it for you. Offline, «Запустити» fails with a clear error; the tasks you
  already started are unaffected.
- Every status change is written to a local `status_outbox` table (SQLite) before it is
  pushed. The pusher retries with exponential backoff (~2 s, doubling to a 60 s cap) and
  also retries immediately after a re-login, so a queue parked on an expired token
  resumes at sign-in.
- The outbox keeps ONE row per task: an offline burst of `thinking → tool → thinking`
  collapses into the newest status, because the board has no use for the ones in between.
  A delivered push retires only the exact version it sent, so a status that arrives while
  that push is in flight survives and goes out on the next pass.
- A clean shutdown enqueues `stopped` for every running task, so the board never hangs on
  `thinking` after you quit Kermanych.
- On the board, a grey banner means THIS BROWSER lost the cloud; an accent pill
  («Статуси цієї машини ще не відправлені: N») means this machine still owes the cloud
  pushes; «⚠ давно без змін» on a card means the assignee's machine has gone quiet
  (there is no heartbeat — it is the age of the task's `updated_at`).

### A task stuck «in progress»

A task's status is written only by the machine running it, and there is no heartbeat by
design — so a machine that crashes (rather than quitting cleanly) leaves its card active
forever, and an active task cannot be reassigned or deleted. Two people can free it with
«Позначити зупиненою» on the card: the **assignee**, from any machine, and the **project
owner**, for when the assignee is gone for good; the database refuses everyone else, and
refuses even the owner any status other than `stopped`. It only corrects the board — it
cannot stop a session on a machine you do not control, and if that machine is still alive
it will simply push its real status again.
