# Kermanych

Kermanych is a local, project-grouped orchestrator for running multiple
[`omp`](https://omp) coding sessions in parallel. It is a NestJS API plus a
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

- **Node 22.x** — REQUIRED. The registry uses `better-sqlite3`, a native
  addon, and its compiled binary is tied to the Node ABI. Running on a
  different major version will fail to load the module.
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

> **Note:** If your Node version changes (e.g. you switch major versions), the
> `better-sqlite3` native binary must be rebuilt for the new ABI:
>
> ```bash
> pnpm rebuild better-sqlite3
> ```

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

Custom `K*` components implement this look; Quasar is used only for the
framework, layout, build, and state plumbing.
