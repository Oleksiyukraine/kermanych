# Kermanych

Kermanych is a local, project-grouped orchestrator for running multiple
coding sessions in parallel. It is a NestJS API plus a
Quasar (Vue 3) UI. Each session gets its own git worktree and its own
agent runtime child, so several agents can work in isolation at the
same time and you drive them all from one board.

Kermanych drives a pluggable `AgentRuntime` behind one factory: a session's
child is either an `omp` runtime (an `omp --mode rpc` child) or a
`claude-code` runtime (via the `@anthropic-ai/claude-agent-sdk`). The backend
is a per-user preference (see below); everything above the runtime seam — the
board, transcripts, worktrees, the RPC bridge — is shared.

- **API** — NestJS. Manages sessions, git worktrees, the SQLite registry, and
  the runtime bridge to each agent child. Speaks REST + WebSocket.
- **UI** — Quasar/Vue 3. A single dashboard for creating sessions, watching
  their turns stream in, and answering interactive prompts.
- **One session = one git worktree + one runtime child** of the session's
  chosen backend (`omp` or `claude-code`). Worktrees live under
  `~/.kermanych/worktrees/<sessionId>`; the registry DB is
  `~/.kermanych/kermanych.sqlite`.

## Prerequisites

- **Node ≥22.12** — REQUIRED. `better-sqlite3` is pinned to v13, whose N-API
  prebuilt binary is ABI-stable across Node ≥22.12 and the bundled Electron, so
  no per-version rebuild is needed. Older Node (including 22.11) crashes the
  native addon.
- **`omp` on your PATH, authenticated.** Sessions on the `omp` backend spawn
  `omp --mode rpc`; if `omp` is missing or unauthenticated, they cannot start.
- **Claude signed in on this machine.** Required when a user's runtime preference
  is `claude-code`. The *binary* does not need to be on your PATH — the SDK ships
  its own as an optional platform package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`,
  ~200 MB) that `pnpm install` fetches. What must come from your machine is the
  **authentication**: the same credentials `claude /login` writes. A signed-out
  machine, or one where that 200 MB package did not install, cannot start
  `claude-code` sessions — the app now names which of the two it is, both when you
  pick the backend and when a session fails to launch.
- **pnpm** (the repo pins its version via `packageManager` in
  `package.json`).

### Runtime preference

Which backend a session uses is a per-user choice. An onboarding gate on first
sign-in picks `omp` or `claude-code`; you can change it later in profile
settings, and the `KERMANYCH_RUNTIME` env var is a dev override. The choice
applies to sessions created afterwards: each session keeps the runtime it was
created with, and resuming or branching a session never switches its backend.

Picking a backend runs a preflight against it — `GET /account/runtime/check?runtime=<kind>`
— so an unusable one is named where the choice is made rather than surfacing later
as a session that never answers. It asks the backend for its model catalog, which
only succeeds if that backend is both installed and signed in, and reports either
`{ ok: true }` or `{ ok: false, code }` where `code` names the fix (signed out vs
binary missing). The check never blocks the choice: you may be about to run
`claude /login`.

If sessions on a backend refuse to start, that same code is what the error names.
To see the raw reason directly, the api logs it at `warn` — including the one line
explaining an empty model picker, which is the loudest symptom of an unusable
backend.

Not every feature is available on both. TTSR triggers, the skill-overlay
config, subscription-plan spend, and the plan/todo chip are `omp`-only; on the
`claude-code` backend, skills reach the agent inline through the prompt. The
agent map (the subagents a session spawned, opened with ◈ on a session) works on
both backends. Per-session token spend is tracked on both.

## The shared board (cloud)

Kermanych's task board is shared through Supabase (auth, workspaces, projects,
membership, tasks, Realtime). Execution stays local — worktrees, `omp` children
and transcripts never leave your machine — but signing in and seeing the board go
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

You do **not** need `GITHUB_SECRET` either. The hosted project holds the team's
GitHub OAuth credentials in the Supabase dashboard; nobody has to send them to
you.

**Sign-in is open:** any GitHub account can sign in and there is no allowlist to
manage. What a new account is *not* given is content — it owns no workspace and
sees nothing at all until it creates one or is invited to one.

### Workspaces, projects and tasks

Three levels, and the first one is the newest:

```
workspace ──► project ──► task ──► session
```

- A **workspace** groups the projects of one product — `back-end`, `admin`,
  `mobile` — and holds its team. Membership lives here and nowhere else.
- A **project** is one git repository. It belongs to exactly one workspace and
  has no owner of its own.
- A **task** is a card on the shared board. Running one creates a **session** —
  a git worktree plus one `omp` child — on the machine of whoever runs it; see
  [Cloud tasks and local sessions](#cloud-tasks-and-local-sessions).

Press **+** beside «Воркспейси» in the sidebar to create your first workspace,
then **+** on its row to create projects inside it.

**Membership is per workspace.** In a workspace's settings its owner invites a
colleague by the email address their account signed in with, and that one
invitation opens every project in the workspace. There are no pending
invitations: the address must already belong to an account, so ask a newcomer to
press **Увійти через GitHub** once before inviting them. Removing a member is the
owner's call too.

| action | who |
|---|---|
| create a workspace | anyone signed in — you become its owner |
| rename or delete a workspace; invite or remove a member | the workspace owner |
| set a workspace's colour or emoji marker | the workspace owner |
| reorder workspaces in your sidebar | any member — a per-account, per-machine view |
| create a project, edit its config, work the board | any workspace member |
| add, rename or remove a project's documentation links | any workspace member |
| delete a project | the workspace owner |
| create a task | any workspace member |
| claim an unassigned task | any workspace member |
| hand over or release an assigned task | its assignee, or the workspace owner |
| force a stuck task to `stopped` | its assignee, or the workspace owner |
| move a project to another workspace | a member of **both** |

Nothing disappears by cascade: a workspace that still holds projects cannot be
deleted at all. Move a project by dragging it onto another workspace's row in the
sidebar, or — without a mouse — by picking the new workspace in the project's
settings. Both paths require membership of the source *and* the destination, and
it is the database that enforces that, not the UI.

**Each workspace carries a marker in the sidebar** — a coloured dot by default, or an
emoji its owner sets in the workspace's settings (a flag, a face, a thumbs-up, from an
iOS-style picker beside the colour). The emoji is part of the workspace and shared: every
member sees it, and the same marker stands in for the dot wherever the workspace is named as
the current scope — the Менеджмент and «Команда ШІ» rails. **Order is the opposite — yours alone.** Drag a workspace's row up or down
to arrange the sidebar; that order is kept per account on each machine, so rearranging your
own view never moves anyone else's.

**Clicking in the sidebar never navigates; it sets the scope.** A workspace scopes
the board to the tasks of every project it holds, and «Агенти» to the sessions and
cards of those same projects. A project scopes both the same way but the board
arrives with the «Проєкти» filter already set to that project. The board's other
filter, «Виконавці», narrows by assignee and offers «Не призначено» for unclaimed
cards.

**The mark at the end of a sidebar row says whether the project needs you.** Only the
most urgent state shows, and hovering the row lists all of them:

| Mark | Meaning |
| --- | --- |
| pulsing orange pill with a number | agents waiting for your answer to a question |
| red dot | an agent failed or hit a merge conflict |
| green pill with a number | agents running |
| orange ring | an agent finished (`done` or a PR in review) and you have not opened it since |
| nothing | nothing going on — no live agents, nothing unread |

A workspace row wears the same mark summed over its projects, so a folded workspace still
shows that something inside it is waiting. Chats, archived and merged agents, and agents
you stopped yourself never mark a row. A result counts as read once you open the agent in
«Агенти» while the window is visible. Read state is kept per machine, in the browser's
local storage; finished agents from before this feature shipped count as read.

**The collapsed sidebar shows workspaces only.** Collapse it with « at the bottom and
the tree shrinks to one mark per workspace; its projects stay hidden until you click that
workspace's mark, which scopes to the workspace and opens its project icons beneath it.
Click the mark again to close it. Every workspace starts closed each time the sidebar is
collapsed, and a project selected from outside the sidebar (a notification, say) opens its
own workspace so the selection stays visible.

**«Задачі» in «Агенти» is your inbox, not a local list.** It shows the cloud cards in
`backlog` assigned to you within the current scope — including the ones a colleague
filed for you. Unclaimed team cards are deliberately absent: they live on «Дошка»
until somebody claims one. The one exception is a pre-cutover local backlog row that
could not be published because its project exists only on this machine; it stays in
the list under the note «Лише на цій машині: проєкт цих задач ще не у хмарі, тому
команда їх не бачить».

**«Приховати з дошки» keeps a card off «Дошка» without hiding it from you.** The
launcher's checkbox, off by default, marks the card as yours alone to look at: it
never reaches the kanban columns, and neither does its status while it runs. It is
still an ordinary task in every other respect — it sits in your «Задачі» inbox and
in the sidebar's count, it launches a session the usual way, it pushes status back,
and every member of the workspace can still read the row. Hiding is a view, never a
permission. Un-hiding is the same checkbox: open the card from «Задачі», clear it,
«Зберегти». That is the only way back, because a hidden card has no card on the
board to click.

### Jira

A workspace can mirror **up to ten Jira Cloud boards** onto «Дошка». The owner connects
each one in **Менеджмент → Integrations** (site → personal API token → board picker), and
may add more from the same card («Додати дошку») until the tenth; re-connecting a board
already present just refreshes it. After the first board the board page grows a «Задачі |
Jira» switcher, and the «Jira» view reproduces one board's own columns, tickets, labels,
comments, worklogs and attachment lists. With several boards connected, a board picker in
the «Jira» toolbar chooses which one you are looking at; the choice is remembered per
workspace. Each board works exactly as the single board does — its own sync, actions and
launches are independent, and its mirror is removed on its own «Відключити».

- **Tokens are personal and local.** Every member who wants to *act* (drag a ticket
  between columns, comment, log work, create/edit/delete tickets, upload files) adds their own
  Atlassian API token on the Integrations tab; it is stored in this machine's
  registry SQLite and never reaches the cloud. Actions land in Jira under that
  member's own account. A member without a token gets a read-only mirror.
- **Jira is the source of truth.** The mirror lives in Supabase behind workspace
  membership; whoever has the Jira view open polls Jira every ~30 s (a shared lease
  keeps N open boards to one poller), and your own actions are written to Jira
  immediately and reflected back at once.
  «Синхронізувати» in the Jira view's toolbar forces that poll now: it skips the
  shared lease and runs a full sweep, so tickets closed or moved in Jira — and any
  change to the board's columns — land immediately instead of at the next tick.
- **Text arrives in Jira formatted, not as markup.** Every body Kermanych writes to
  Jira — a description (from the ticket editor or the Менеджмент chat), a comment, a
  worklog note — is Markdown converted to Jira's own document format: `##` becomes a
  heading, `- [ ]`/`- [x]` become Jira action items (checkboxes), and lists, tables,
  code, quotes, bold/italic/strike and links become their Jira equivalents. The
  editor opens an existing ticket with its description read back as the same
  Markdown, and leaves the description untouched when you only change other fields —
  images, mentions and panels, which Markdown cannot carry, survive such an edit.
- **Work is logged where it is done.** The ticket dialog's «Ворклоги» tab reproduces
  Jira's own «Log work»: time spent in Jira's spelling («3h 20m»), when it started,
  an optional description, and what the entry does to the remaining estimate
  (subtract automatically, leave alone, set to, reduce by). The worklog is written to
  Jira under the acting member's own account — so it carries their name there — and
  the ticket's «Витрачено»/«Залишилось» move with it. An existing entry can be
  corrected or removed from the same list, with the estimate question Jira asks in
  each case; the «Редагувати»/«Видалити» controls appear only on the entries Jira
  says this member may touch (its own edit-own vs edit-all worklog permissions).
- **Tickets launch like tasks.** «Запустити» on a ticket asks which Kermanych
  project (repo) to run in — pre-selected from the sidebar — and which Jira status
  to move the ticket to (skipped when it is already in an In-Progress-category
  status). The session runs through the ordinary pipeline on a hidden shadow task;
  the ticket card wears the agent's live status chip. When the session is merged,
  Kermanych asks where the ticket should go next and applies that transition in
  Jira.

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
`42501 permission denied`, and the policies isolate each user to the workspaces
they are a member of — and so to the projects and tasks inside them. Sign-in is
open, so RLS is the sole authorization surface — every request runs under the
user's own JWT. **No secret
key ever belongs on a machine running Kermanych**, and nothing in this repo reads
one.

### Applying a migration to the team's project

`supabase/migrations/**` is the schema of record, and the hosted project is NOT
updated by merging a branch. A migration that is committed but never pushed
leaves the shipped UI calling something that does not exist: PostgREST answers
`PGRST202 Could not find the function … in the schema cache`, which is exactly
how an unpushed `invite_project_member` (20260823130000, since retired in favour
of `invite_workspace_member`) surfaced in the members panel — «Запросити» failed
for every address. Push from a clone linked to the project, with the CLI logged
in (`supabase login`):

```bash
supabase link --project-ref uqqdudlfizfwqfegfrlh   # once per clone
supabase migration list --linked                   # local vs remote history
supabase db push --linked --dry-run                # what would be applied
supabase db push --linked
```

`db push` applies only the versions missing from the remote history table, so
re-running it is a no-op. `db reset` is for the LOCAL stack only and never
touches the hosted database.

A migration that only *adds* is safe to push whenever. One that drops a column the
shipped client still selects needs a window and an announcement:
`20260827100000_workspaces.sql` is one of those, and
[`docs/cutover-workspaces.md`](./docs/cutover-workspaces.md) is its runbook.

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

> **Note:** `better-sqlite3` v13 and `node-pty` 1.1 ship N-API prebuilt binaries, so
> switching Node versions (≥22.12) needs no rebuild.

## Desktop app (macOS)

Kermanych also runs as a desktop app (Electron via Quasar): one window that
starts the API in-process — no browser, no separate dev servers.

```bash
pnpm dev:app      # run the desktop app in dev
pnpm build:app    # build a macOS .dmg (unsigned)
```

Links never open inside the desktop window: every `http(s)`/`mailto` link — Jira
and Linear tickets, attachments, storage downloads, markdown links, and the session
live preview — opens in your default browser (Chrome, Arc, Safari, …).

The one deliberate exception is **Менеджмент → Project Documentation → Посилання**.
The screen splits documentation into two tabs, always both present, on two levels:
**Репозиторій** is per project (pick the project, then browse the bound checkout's doc
folders) and **Посилання** is per *workspace* (pages outside any repository, shared by
every project of the workspace — the project switcher does not apply to it, and the tab
is there even with no project selected or bound); each tab keeps its own open item. Links
the team adds on the **Посилання** tab (a Google Doc, a Figma file, a published Claude
artifact, any page) are shown as preview cards and open *embedded* in the screen's
preview pane, with a full-screen toggle (`Esc` leaves it). Only the title and URL are
stored, in the cloud table `workspace_doc_links` (created per project by
`20260928110000_project_doc_links.sql`, moved to the workspace by
`20260929090000_workspace_doc_links.sql`, which re-homes existing links to their
project's workspace — push it before shipping this UI). Known providers are loaded through their embed form
(a Google Doc's `/edit` becomes `/preview`, a YouTube `/watch` becomes `/embed/…`).
Before drawing a page the local API asks its host whether it may be framed
(`GET /api/docs/embed-check?url=…` reads `X-Frame-Options` / CSP `frame-ancestors`);
a page that refuses — GitHub, or a private Google Doc that redirects to Google sign-in,
which the app's window is not signed in to — gets **Відкрити в браузері** instead of a
blank frame. That button always opens the stored URL in your default browser.

The build is **unsigned**, so on first open macOS Gatekeeper blocks it. Open it
with **right-click → Open** (once), or clear the quarantine flag:

```bash
xattr -cr /Applications/Kermanych.app
```

Native module note: `better-sqlite3` is pinned to v13 (N-API) and `node-pty` to 1.1
(N-API prebuilds for macOS and Windows); one prebuilt binary works under both the Node
(≥22.12) and Electron ABIs, so no rebuild. Both are unpacked from the asar. `node-pty`
1.1's tarball ships `spawn-helper` without the exec bit, which makes every terminal fail
with `posix_spawnp failed`; the API restores it before the first shell and the app build
sets it in the bundle.

## Integrated terminal

Every project can open a shell, like the terminal panel of VS Code: the **`>_`** button
in the status bar, or <kbd>Ctrl</kbd>+<kbd>`</kbd> (also from inside the terminal),
toggles a panel under the page. Opening it on a bound project with no terminal starts
one; **+** adds another tab, 🗑 ends the active one, ✕ hides the panel; drag its top
edge to resize (the height and whether it is open are remembered).

- The shell is your login shell (`$SHELL -l`, so the profile's `PATH` applies even in the
  desktop app) started in the project's bound folder. An unbound project has no terminal.
- Tabs belong to the selected project. Switching project shows that project's terminals;
  the others keep running.
- Terminals live in the local API, not in the window: reloading the UI re-attaches to
  them and repaints the last 256 KiB of output. They end when the shell exits, when you
  kill them, or when the API (the desktop app) quits.
- Transport is the `/terminal` socket.io namespace of the API. Its handshake must carry
  the same bearer token the REST API accepts (`auth: { token }`) — a socket there can run
  commands, so no other page on the machine may connect to it.

## Monorepo layout

pnpm workspaces (`packages/*`, `apps/*`):

- **`packages/core`** — framework-agnostic domain logic: worktrees, the
  SQLite registry, RPC frame handling, session status. Unit-tested with
  vitest.
- **`packages/cloud`** — the Supabase client and the typed cloud surface (auth,
  workspaces, projects, membership, tasks, Realtime) shared by the API and the
  UI. Its RLS/trigger suite runs against a real local stack; see above.
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

1. **Create** — any member of the project's workspace creates a task, from the board
   (`/#/board`) or from «Агенти» / «Чат», with a title, a description and optional launch
   params (model, branch prefix, platform, base branch). A card filed from the board is
   unassigned unless its author picks someone; a card filed from «Агенти» or «Чат» is
   assigned to its author, because that is the machine about to run it. Either way it is a
   row in the cloud `tasks` — there is no local-only task — so the whole workspace sees it.
   It starts in `backlog`, which exists only in the cloud.
2. **Assign** — the assignee may hand a card over or release it, and the workspace owner
   may take one back from someone who is gone. Anyone may claim an UNASSIGNED card, and
   pressing «Запустити» on one self-assigns it atomically. Taking a card assigned to
   somebody else is refused by the database, not just by the UI — which is why the control
   is greyed out before the attempt rather than explaining afterwards. An active task
   (`queued`, `thinking`, `tool`, `waiting_input`) can be neither reassigned nor deleted.
3. **Bind** — a cloud project has no idea where its repo lives on your disk. The first
   «Запустити» for an unbound project asks for the local git repository and stores that
   path locally (it never reaches the cloud).
4. **Run** — `POST /api/sessions/from-task` creates a git worktree under
   `~/.kermanych/worktrees/<sessionId>`, copies the project's `carryFiles` (`.env` by
   default) into it, and spawns one `omp --mode rpc` child. From here on the session is an
   ordinary local session: it appears on the Агенти board and you drive it there.
5. **Status flows back** — the local API mirrors the session's coarse status
   (`queued → thinking → tool → waiting_input → done | in_review | error | stopped |
   merged | conflict`) to the task, and everyone's board updates live over Supabase
   Realtime. `in_review` is the pull-request outcome: «Завершити» → «Створити ПР» has the
   agent commit, push and open the PR, and when that turn ends the card lands in the
   board's «На ревʼю» column — settled, but waiting on a human reviewer rather than
   closed. «Завершити» → «Влити» is the other exit and still lands on `merged`. Once a
   session's branch has an open PR, that fact is
   durable: the finish sheet's secondary action stays «Закоміти» (never «Створити ПР», which
   would try to open a second PR and find nothing to push), and EVERY later turn settles the
   card back on «На ревʼю» — even the plain follow-up prompts you send to fix review findings,
   which drive the card through «в роботі» mid-turn. «Закоміти» has the agent commit and push
   that follow-up work onto the same branch, updating the open PR.

Nothing else leaves your machine. Transcripts, the current tool, context usage, todo
phases, interactive prompts and the provider-plan spend under the account name (read from
`omp usage` on this machine, never mirrored) are local-only by design — the board shows
THAT a task waits for input, and only the person running it can answer, on their own
machine.

### Project documentation

A project can require that its tasks are documented in its repository. The rules live in the
framed «Документація» subsection of the project's «Основне» settings. The switch «Увімкнути
правила документації» is off by default, because it can block pull requests for the whole
project. Once it is on, every session of the project (chats, agents, discussions, reviews,
resumes) is told where documentation goes and which of it is required, whichever runtime it
uses, and Kermanych checks the required part before letting work leave the branch.

The layout is fixed and repository-relative. These folders override any skill or plugin
default, superpowers' `docs/superpowers/specs|plans` included. Each kind has its own rule:

| Group | Kind | Folder | Rules | Default |
| --- | --- | --- | --- | --- |
| Документація задачі | task document | `docs/specs/YYYY-MM-DD-<topic>.md` | off · optional · required | required |
| | plan | `docs/plans/YYYY-MM-DD-<topic>.md` | off · optional · required | optional |
| Жива документація | how the service works | `docs/schemas/` (or the project's own docs) | off · optional · required | required |
| Фронтенд ↔ бекенд | frontend handoff | `docs/handoffs/YYYY-MM-DD-<topic>.md` | off · optional · ask · required | ask |
| | API extension request | `docs/api-requests/YYYY-MM-DD-<topic>.md` | off · optional · ask | off |

- **off** — the agent is not told about the kind; nothing is checked.
- **optional** («За потреби») — the agent writes it where it applies; nothing blocks.
- **ask** («Питати») — the finish sheet shows a checkbox for it: «Хендоф для фронта» (on
  each time the sheet opens) or «Запит на розширення API» (off). Ticked, the document is
  required.
- **required** — the document is required on every branch that changes the repository.

The defaults are exactly what the single «Обовʼязкова документація» switch meant before the
rules existed, so a project that had it on behaves the same until someone changes a rule.

**API extension requests** are the answer to "the frontend needs something the API does not
have yet". With the kind on, the agent does not invent the backend side or fake it silently:
it writes `docs/api-requests/…` — what is needed and why, the proposed contract, what the
client does until it ships — and names it in the handoff or PR. A backend task that answers
a request links it from its handoff.

«Створити ПР», «Закоміти» and «Завершити» are refused (by the API, not just the UI) until
every required document is on the branch:

- task document / plan / handoff / API request: the branch changes a markup file in that
  folder;
- living documentation: if code changed, the living documentation changed too
  (`docs/schemas/` or the project's other docs). The one escape hatch is explicit: a task
  document has a `## Documentation impact` section whose first line starts with `None`,
  followed by the reason. The reviewer sees that reason in the diff.

The finish sheet shows the checkboxes of the kinds set to «Питати» and lists whatever is
still missing in plain language. «Доповнити документацію» sends the agent one prompt naming
exactly the missing documents and closes the sheet. You watch the agent write and commit them
in the transcript, and it pushes them if the PR is already open. Changed documents appear in
the session's «Документація» tab tagged специфікація / план / схема / хендоф / запит API.

The instructions for each document are the default skills `task-spec`, `task-plan`,
`frontend-handoff` and `api-request`. Like any default skill, a project, workspace or
repository can override them by name («ШІ-команда → Навички»; the settings subsection links
there).

The API takes the finish sheet's boxes as `{ handoff?: boolean; apiRequest?: boolean }` on
`POST /sessions/:id/pr|commit|finish|docs` and as `?handoff=1&apiRequest=1` on
`GET /sessions/:id/finish`; the answer's `docsGate` is `{ enabled, asks, failures }`. The rules
are stored in `projects.docs_policy` (migration `20260930090000_project_docs_policy.sql`, to be
applied before deploying the API, which selects the column); `projects.docs_required` stays
the switch.

**Superpowers and other plugins.** Kermanych does not depend on them: the policy, the skills
and the gate work with no plugin installed. When superpowers is present, its
`brainstorming` and `writing-plans` skills state that their `docs/superpowers/specs|plans`
paths are defaults that user instructions override, and the policy is exactly such an
instruction, so specs and plans land in `docs/specs` / `docs/plans`. Superpowers has no notion
of `docs/schemas`, `docs/handoffs` or `docs/api-requests` and does not add the
`## Documentation impact` section. Those come from the policy, the skills and the gate.
Whether the claude-code runtime loads `~/.claude` plugins at all is unverified: Kermanych sets
no `settingSources`.

**Limits.** A session that was already running when the switch or a rule changed gets the new
policy in its system prompt on its next spawn (resume, restart). The gate applies to it
immediately. A pull request opened by a trigger ticks no finish-sheet box, so only the
`required` rules apply to it.

Design, decisions and rationale:
[`docs/specs/2026-09-28-mandatory-documentation-design.md`](../docs/specs/2026-09-28-mandatory-documentation-design.md),
per-kind rules:
[`docs/specs/2026-09-30-documentation-settings.md`](../docs/specs/2026-09-30-documentation-settings.md).

### Offline behaviour

Local work never waits for the cloud:

- A session that already exists keeps running, answering, merging and finishing with no
  network at all — the local `projects` row caches the project config, so nothing on
  that path reads the cloud.
- CREATING a task and STARTING one are the two steps that need the cloud: a task is a cloud
  card, so Kermanych has to write it and claim it for you. Offline, «Нова задача» and
  «Запустити» fail with a clear error; chats, the sessions you already started, and every
  merge and finish keep working with no network at all.
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
«Позначити зупиненою» on the card: the **assignee**, from any machine, and the
**workspace owner**, for when the assignee is gone for good; the database refuses
everyone else, and refuses even the owner any status other than `stopped`. It only
corrects the board — it
cannot stop a session on a machine you do not control, and if that machine is still alive
it will simply push its real status again.

## The Менеджмент tab and its assistant

Менеджмент is the non-code half of the product: seven workspace-scoped sections
(`packages/core/src/management.ts` is the one table that names them) plus a chat
field docked to the foot of the page.

That field is a real assistant, and it is deliberately narrow:

- **It only reads code, and it writes in exactly five places.** Its file tools are the
  read-only subset (`read`, `grep`, `glob`) — it can look at your repositories but it cannot
  edit a file, create a branch or start a session. The Менеджмент sections it can WRITE are
  the ones the section table marks `read_write`: the Risk Registry, Release Notes, and the
  Home overview — the last through create, update and delete on its Action List tile (below).
  Everywhere else in Менеджмент it reads, explains and refuses, and says which it is doing.
  The fourth write target is not a section at all — it is «Дошка», where it files tickets
  (below) — and the fifth is Jira itself, through its live Jira tools (below).
- **It keeps the risk register.** Ask it to file a risk and it emits a `risk.create`
  action carrying that schema's own vocabulary — threat or opportunity, one of the
  fourteen categories, cause·event·consequence, 1–5 probability × impact, a PMI
  response strategy with the actions that make it one. `risk.update` changes a row you
  name by its register code (`R-003`). The write runs in your browser under your own
  JWT, so RLS decides whether it lands, and the line you read afterwards
  («Ризик R-004 занесено…») is written by the app after Postgres answered — never by
  the model. Every turn also carries the current register, so it updates R-004 instead
  of filing it twice. Owners are not something it can set: `risk_owner` and
  `action_owner` are profile ids, and those are assigned on the register screen. It also
  exports the register as PDF or Excel on request (`risk.export`, see *Exporting the risk
  register* below).
- **It writes release notes from the chat.** Type «зроби реліз-ноти по main за останній
  тиждень» into that field and it emits a `release.notes` action naming the project, the
  branch and the period — there is no button to press and no form to fill. A relative
  period is resolved by the model against the `Сьогодні:` line every turn carries, and a
  date that is not a date («останній тиждень» left in the field) is refused in your browser
  with the value quoted back, not as a 400 one round trip later. The project is named the
  way the prompt showed it to you — by NAME, never by id — and an ambiguous name is a
  question rather than a guess, because a note generated against the wrong repository is a
  document about somebody else's work. What happens next is literally the same job the
  section screen's own form starts — the chat hands it to the same store — so the run
  outlives the turn that asked for it: the local API reads that branch's commits on THIS
  machine (it is the only party that can) and spends a second, one-shot `omp` child to write
  the document; your browser then stores it in `workspace_release_notes` under your own JWT,
  so it is on the Release Notes screen for every member. The chat does not sit and wait, and
  neither do you: it records that it started the generation, and the toast at the end names
  the title and the commit count wherever you have walked to — a note written from three
  commits reads very differently from one written from ninety, and that number is your first
  clue the range or the branch was not the one you meant. A failed run keeps a row on the
  section screen with its reason and a retry. Editing, copying and deleting a stored note
  stay on the screen; the assistant has no verb for them and the prompt says so.
- **It reads the team's capacity.** Team Capacity is the one section marked `read`: the
  screen adds up the Jira board's remaining estimates (spread over business days up to
  each ticket's due date) and its worklogs against 8 h per person per business day, for a
  date range you pick, as a chart or a table, for the whole team or the people you tick
  in the roster picker — the chart, the table and the totals all show that same selection. The
  browser hands the assistant the same numbers by week — two weeks back, six ahead — as
  `context.capacity` on every turn, so «what's Marina's load for the next two weeks» is
  answered from the figures on the screen, never from the model's memory. Nothing there is
  writable: load changes by editing tickets in Jira, and the assistant says so. A
  workspace without a Jira board has no capacity to show — the native board carries no
  estimates — and both the screen and the context block state that.
- **It sees your Home overview, and it keeps your Action List.** The dashboard the
  Менеджмент tab lands on — the tile layout exactly as you arranged it, your Action List,
  today's tasks per person and the recent release notes — travels to the assistant as
  `context.home` on every turn, computed by the same functions the tiles render
  (`apps/ui/src/lib/home-digest.ts`), so «проаналізуй мою головну» is answered from the
  dashboard you are looking at: what is overdue, whose day is overloaded, which items
  are still open. It edits the Action List with full CRUD: «додай у список: …» emits a
  `todo.create` action (plain-text items, checkbox or numbered), «зміни пункт 2 …» a
  `todo.update` and «прибери пункт 3» a `todo.delete`. Update and delete address a row by the
  `#N` position the digest prints beside it — the list's ids never leave the browser — and the
  executor lands the change in the same store the tile renders, so it is on the dashboard
  before the confirmation line prints. Moving and resizing the tiles stay on the tile
  (every mirror tile is owned by the section it snapshots), and the list itself is your own
  scratch pad, stored only in your browser — the assistant says so instead of promising the
  team will see it.
- **It files and edits tickets on «Дошка».** Say «створи тікет: …» and the ticket appears on the
  board — the board is not a Менеджмент section, so this works from any section, and «створи
  тікет» (or «зміни KRM-101») is never answered with a refusal. What makes it worth having:
  - **The default board is the workspace's own.** «Задачі» is the board that always exists,
    needs no integration and no personal token, so a request that does not name a board lands
    there (`ticket.create`). Jira is opt-in BY NAME: only «створи в Jira…» routes there (the
    `jira_create_issue` tool), and when the workspace has several boards the request names the
    project or board (or the assistant asks); a workspace with one Jira board needs no naming.
    Naming Jira in a workspace that has none — or on a machine with no personal Jira token — is
    refused with the reason, and NOT quietly filed on the native board instead: you named a
    board, and a card on the other one is a card you will not find where you looked.
  - **The ticket is written as a project manager writes one, and the app owns its shape.**
    The action carries five named slots — a business context, an optional user flow,
    acceptance criteria, an optional out-of-scope list, and the title — and
    `renderTicketDescription` turns them into the card body. So every ticket from this chat
    has the same headings in the same order, and there is no field in which a schema, an
    endpoint or a library could be specified: WHAT and WHY are the ticket's, HOW stays the
    team's. Before writing, the assistant reads the workspace's repositories to ground the
    ticket in what the product actually does today — but only the business conclusion reaches
    the card.
  - **The ticket is written in English, whatever language you asked in.** A card is read by
    whoever picks it up, and that is rarely only the person who dictated it — so the ticket's
    own text (title, context, user flow, acceptance criteria, out of scope) is English, and
    the app's headings above them are English for the same reason. Asking «створи тікет про
    історію змін» gets you an English ticket, not a Ukrainian one: the language of the request
    carries no instruction about the language of the card. Another language is opt-in BY NAME
    — «тікет українською» — exactly like the second board. Interface labels the product shows
    in Ukrainian stay quoted as they are («the «Історія» tab»), because a translated label is
    a label nobody can find on the screen. The chat's own prose, and the questions below,
    stay in your language: those you are the one reading.
  - **A ticket never ships an open question.** If something is missing that only you can
    decide — the scope, an edge case, the assignee, which project — the assistant emits
    `ticket.questions` instead: the chat prints the numbered questions and states that the
    ticket was NOT created. Answer in the next message and it files the ticket; do not answer
    and there is no ticket. Belt and braces: a NEW ticket whose text still contains «TBD», «to
    be decided», «needs clarification», «at the developer's discretion» — or their Ukrainian
    counterparts, for the tickets you asked in Ukrainian — a `<placeholder>`, a code fence or
    an acceptance criterion phrased as a question is refused (in your browser for the native
    board, by the Jira tool for Jira) with the offending fragment quoted back.
  - **Each board has its own people, and neither list is guessed.** They are not the same set.
    For the workspace's own board, `tasks.assignee_id` is a profile id, so every turn carries
    the workspace roster by the same name the app shows you and the browser matches the name
    back to that id. For Jira the roster has no say at all: a Jira assignee is an Atlassian
    account, so the name you said goes to the Jira tool, which resolves it against the people
    Jira itself will accept for that project — someone with a Jira seat and no Kermanych
    account is assigned exactly as you would assign them by hand, and an ambiguous or unknown
    name comes back to the assistant with the candidates instead of landing in nobody's queue.
  - **Several tickets in one request.** «Розбий це на тікети» or «створи п'ять тікетів на …»
    files every ticket, each held to the same rules as a single ticket. On the native board a
    series is several `ticket.create` actions; on Jira it is a real hierarchy (below).
- **It works in Jira live, with the same reach as a Jira MCP server.** The assistant is given
  a set of `jira_*` tools, served by the local API as an MCP endpoint
  (`POST /api/management/mcp`, `apps/api/src/jira/jira-tools.service.ts`) and called DURING
  the turn — so it sees Jira's answer, including a refusal, and can fix and retry before it
  replies. Every call runs under your own personal Jira token and reaches only the sites of
  the boards the workspace connected; each chat's agent child gets its own bearer secret,
  revoked with the conversation. The claude runtime takes the endpoint as a native MCP server
  (`mcp__kermanych__jira_*`); omp, which reads MCP servers only from config files, gets it
  through a small generated extension (`apps/api/src/runtime/omp-mcp-bridge.ts`) with the URL
  and secret in its environment. What that covers:
  - **Reading the whole picture.** JQL search across the site (any project, open or done,
    paged), a full issue read (every field with custom fields by name, description and
    comments as markdown, parent, subtasks, issue links, attachments, time tracking, and on
    request changelog, worklogs, transitions, remote links and watchers), attachment download
    for the read tool, and the vocabularies: projects, boards, issue types with hierarchy,
    the create and edit screens (required fields and allowed values), field ids, statuses,
    transitions, link types, users, sprints, versions and components.
  - **Writing.** Create (issue type required — taken from the project's own list — plus
    priority, assignee, labels, components, fix versions, parent, dates, estimate and any
    custom field by id), update (only what is named; `description` replaces the whole body,
    so it is read first; labels can be added or removed one at a time), transition by status
    or transition name (with transition-screen fields and a comment), comments (add, edit,
    delete), worklogs, issue links and web links, watchers, attachments (the files you
    attached to this conversation, images included, by the exact names the turn lists),
    delete, sprints (create, update, start/close, add issues, move to backlog) and versions
    (create, update, release, archive). New Jira tickets use the same five slots, English
    rule and open-question refusal as native ones.
  - **Sequences that hold together.** An epic and its stories — or a story and its sub-tasks —
    are filed one at a time, parent first, each child created with the key Jira just returned
    as its parent; ordering and dependencies become real issue links («KRM-1 blocks KRM-2»).
    A write Jira accepted is always reported with its key, even when the board mirror could not
    be refreshed afterwards (the mirror catches up on its next sync), so a series never stalls
    or duplicates on a mirror hiccup.
  - **What you see.** Every Jira write prints its own line in the chat («Jira: створено KRM-215
    — …», «Jira: KRM-101 → Done»), the board mirror is refreshed so «Дошка» shows the change
    at once, and the assistant's prose summarises only what the tools confirmed. Deleting an
    issue, a comment or a link happens only when you asked for exactly that.
  - **Not covered** (present in some Jira MCP servers): Jira Service Management queues and
    customer requests, ProForma forms, development info (PRs/commits), moving an issue to
    another project, entity properties, dashboards and saved filters.
- **It spends the same subscription your agents spend.** It runs through the same
  `omp` on your PATH, the same provider account and the same plan; there is no second
  key to configure and no separate budget. The mono pill on the right of the field is
  that plan's tightest rolling window, read from `omp usage` — the same figure the
  sidebar shows.
- **It is scoped to the Воркспейс, and so is the tab it lives in.** Every turn carries the
  repositories of that Воркспейс — name, remote, default branch, conventions and
  the local path where each is bound on this machine — so «which of our repos does this
  affect» is answerable. Unbound projects are listed as unbound rather than guessed at.
- **It says why when it cannot act.** Ask it to change Team Capacity or Integrations and it
  refuses with that section's stated limitation. The refusal is not the model being polite:
  the model reports only WHICH section was asked for, and the sentence you read is looked
  up in the section table by the app (`ManagementAction` `unsupported`,
  `packages/core/src/management-actions.ts`). A model that would rather agree with you
  cannot make that sentence disappear — and a refusal aimed at a section that IS writable
  is reported as the prompt malfunction it is, not dressed in a limitation the table does
  not have.

### Exporting the risk register

The Risk Registry screen exports to **PDF** or **Excel (.xlsx)** from the **Export** button in
its toolbar. The dialog asks for two things:

- **Which risks.** *Whole register* is every risk in the workspace, whatever the filters
  show. *Selected rows* is the rows ticked in the table's first column; the header box ticks
  every row the current filter shows, and a selection survives filter changes, so you can
  search, tick, and search again. The selection is dropped when you switch workspaces. Rows
  come out in the table's current sort order.
- **Which format.** The PDF is for reading: landscape A4, one row per risk with the
  statement, both scores banded like the screen, the response and its owner, and rows over
  tolerance marked. The Excel sheet is for working with the data: every field, one row per
  risk, scores and money as numbers, a frozen header and a filter.

The desktop app renders the PDF itself (Chromium's `printToPDF` in the main process,
`apps/ui/src-electron/print-pdf.ts`) and both formats end in the usual Save dialog. In a
plain browser tab there is no way to write a PDF file, so the document opens in the print
dialog instead, and you choose «Save as PDF» there. Both files are built in the browser from
the register already on screen (`apps/ui/src/lib/risk-export.ts`), so exporting never goes
back to Supabase.

You can also ask for the file in the Менеджмент chat, from any section: «експортуй реєстр у
PDF», «вивантаж відкриті загрози в Excel». The assistant emits a `risk.export` action with
the format (`pdf` or `xlsx`) and, for part of the register, the codes of the rows it picked
from the register every turn carries — a description like «все з експозицією від 12» is
turned into codes by the model, never interpreted by the app. If you did not name a format it
asks which one. Your browser then builds the file through the same function the Export button
uses (`saveRiskRegister` in `apps/ui/src/lib/export-file.ts`), rows in the screen's default
order (by exposure), and the chat line names the file — or, in a plain browser tab, says the
PDF opened in the print dialog. A code the register does not hold exports nothing: a file
quietly missing a row you asked for would be forwarded as complete.

### Giving another section something it can write

The Risk Registry and Release Notes are wired end to end; Team Capacity is `read` (a screen
and a context digest, nothing to write); every remaining section is `none`, and the chat
has no write path into them on purpose. Adding one is three edits,
and they belong to the branch that owns the screen being written to:

1. flip that section's row in `packages/core/src/management.ts` to `capability:
   "read_write"` and drop its `limitation`;
2. add the action kind to `ManagementAction` in
   `packages/core/src/management-actions.ts`, with the vocabulary that section's table
   actually enforces — `validateManagementAction` is what stops the model inventing a
   value the database would reject, and the prompt in
   `apps/api/src/management/management-prompt.ts` prints that same vocabulary so the
   two cannot drift;
3. give the executor in `apps/ui/src/stores/management-chat.ts` a branch for it.

Release Notes is the worked example of a write that is not a row insert: its executor
branch calls the local API for the document before it stores anything, and its protocol
block states which of the screen's operations it deliberately does NOT have. A `read_write`
row carries no `limitation` — a limitation is printed as a refusal — so a partial vocabulary
has to say so in the prompt instead.

Step 3 stays in the **browser**, under your own JWT — the API must never gain a write
path of its own. That is what makes RLS, rather than trust in the model, the thing that
decides what lands: an action aimed at a workspace you are not a member of is refused by
Postgres. The app refuses earlier too, and twice: an action block that does not
type-check is reported in the chat and never executed, and an unknown `kind` is named
back to you instead of silently dropped.

### Its conversation

One conversation per Воркспейс (`management:<workspaceId>`), held open as a git-free child
on your chosen runtime (`omp` or `claude-code`) in the first bound repository of the group
— or in your home directory when none is bound — with no worktree, no branch and no row on
the Агенти board. Switching workspace in
the sidebar switches conversation; «Новий чат» drops the child so the next question starts
from nothing. An idle conversation is stopped after a while, and the next message simply
spawns a fresh one.
