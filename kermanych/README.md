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
