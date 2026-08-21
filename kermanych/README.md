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

## Cloud prerequisites

Kermanych's task board is shared through Supabase (auth, projects, membership,
tasks, Realtime). Execution stays local — worktrees, `omp` children and
transcripts never leave your machine — but you need a Supabase backend to sign
in and to see the board.

**Either** a hosted project (<https://supabase.com/dashboard>) **or** a local
stack (Docker + the [Supabase CLI](https://supabase.com/docs/guides/local-development)):

```bash
supabase start        # from the repo root; prints the API URL, anon key, service_role key
supabase db reset     # apply supabase/migrations/*.sql to a clean database
supabase status       # re-print the URLs and keys at any time
```

This repo's `supabase/config.toml` pins the local stack to the **544xx** band
(API `http://127.0.0.1:54421`, database `postgresql://postgres:postgres@127.0.0.1:54422/postgres`),
not the CLI's default 543xx, so it can coexist with another Supabase project on
the same machine. Every URL below uses those ports.

**GitHub OAuth App** — GitHub allows one callback URL per app, so a local stack
and a hosted project need one each (<https://github.com/settings/developers>):

| target | Authorization callback URL |
|---|---|
| local stack | `http://127.0.0.1:54421/auth/v1/callback` |
| hosted project | `https://<project-ref>.supabase.co/auth/v1/callback` |

For the local stack, export the app's credentials **before** `supabase start` —
`supabase/config.toml` substitutes them into `[auth.external.github]`:

```bash
export SUPABASE_AUTH_GITHUB_CLIENT_ID=Ov23li…
export SUPABASE_AUTH_GITHUB_SECRET=ghs_…
```

For a hosted project, set the same pair under Authentication → Providers →
GitHub, and add both redirect URLs (`http://localhost:5317/**` and
`http://127.0.0.1:53170/callback`) under Authentication → URL Configuration.
The second one is the fixed loopback the desktop app listens on.

**Four environment variables** — the API and the UI each need the same pair,
under different names (Vite only inlines `VITE_`-prefixed variables). All four
hold public values; the anon key is safe to expose because RLS is the
authorization surface. **No service-role key ever belongs on a machine running
Kermanych.**

| variable | consumer | value |
|---|---|---|
| `SUPABASE_URL` | `apps/api` | the API URL |
| `SUPABASE_ANON_KEY` | `apps/api` | the anon key |
| `VITE_SUPABASE_URL` | `apps/ui` | the same API URL |
| `VITE_SUPABASE_ANON_KEY` | `apps/ui` | the same anon key |

Export the first pair in the shell that runs `pnpm dev:api` (or `pnpm dev:app`,
which hosts the API in-process), and put the second pair in `apps/ui/.env`:

```bash
# apps/ui/.env — public values only, not committed
VITE_SUPABASE_URL=http://127.0.0.1:54421
VITE_SUPABASE_ANON_KEY=<anon key>
```

**Running the cloud tests.** `packages/cloud`'s unit suite needs nothing. Its
RLS/trigger integration suite is skipped unless all three of these are set, and
`SUPABASE_TEST_SERVICE_KEY` is a *test fixture only* — it mints throwaway users
through the admin API and is never read by shipped code:

```bash
supabase start && supabase db reset
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY=<anon key>
export SUPABASE_TEST_SERVICE_KEY=<service_role key>
pnpm --filter @kermanych/cloud test
```

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
