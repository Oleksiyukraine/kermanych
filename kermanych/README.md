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
| create a project, edit its config, work the board | any workspace member |
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

**Clicking in the sidebar never navigates; it sets the scope.** A workspace scopes
the board to the tasks of every project it holds, and «Агенти» to the sessions and
cards of those same projects. A project scopes both the same way but the board
arrives with the «Проєкти» filter already set to that project. The board's other
filter, «Виконавці», narrows by assignee and offers «Не призначено» for unclaimed
cards.

**«Задачі» in «Агенти» is your inbox, not a local list.** It shows the cloud cards in
`backlog` assigned to you within the current scope — including the ones a colleague
filed for you. Unclaimed team cards are deliberately absent: they live on «Дошка»
until somebody claims one. The one exception is a pre-cutover local backlog row that
could not be published because its project exists only on this machine; it stays in
the list under the note «Лише на цій машині: проєкт цих задач ще не у хмарі, тому
команда їх не бачить».

### Jira

A workspace can mirror **one Jira Cloud board** onto «Дошка». The owner connects it
in **Менеджмент → Integrations** (site → personal API token → board picker); after
that the board page grows a «Задачі | Jira» switcher, and the «Jira» view reproduces
the board's own columns, tickets, labels, comments, worklogs and attachment lists.

- **Tokens are personal and local.** Every member who wants to *act* (drag a ticket
  between columns, comment, create/edit/delete tickets, upload files) adds their own
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
   (`queued → thinking → tool → waiting_input → done | error | stopped | merged |
   conflict`) to the task, and everyone's board updates live over Supabase Realtime.

Nothing else leaves your machine. Transcripts, the current tool, context usage, todo
phases, interactive prompts and the provider-plan spend under the account name (read from
`omp usage` on this machine, never mirrored) are local-only by design — the board shows
THAT a task waits for input, and only the person running it can answer, on their own
machine.

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

Менеджмент is the non-code half of the product: six workspace-scoped sections
(`packages/core/src/management.ts` is the one table that names them) plus a chat
field docked to the foot of the page.

That field is a real assistant, and it is deliberately narrow:

- **It only reads code, and it writes in exactly three places.** Its tools are the read-only
  subset (`read`, `grep`, `glob`) — it can look at your repositories but it cannot edit a
  file, create a branch or start a session. The Менеджмент sections it can WRITE are the ones
  the section table marks `read_write`: the Risk Registry and Release Notes. Everywhere else
  in Менеджмент it reads, explains and refuses, and says which it is doing. The third write
  target is not a section at all — it is «Дошка», where it files tickets (below).
- **It keeps the risk register.** Ask it to file a risk and it emits a `risk.create`
  action carrying that schema's own vocabulary — threat or opportunity, one of the
  fourteen categories, cause·event·consequence, 1–5 probability × impact, a PMI
  response strategy with the actions that make it one. `risk.update` changes a row you
  name by its register code (`R-003`). The write runs in your browser under your own
  JWT, so RLS decides whether it lands, and the line you read afterwards
  («Ризик R-004 занесено…») is written by the app after Postgres answered — never by
  the model. Every turn also carries the current register, so it updates R-004 instead
  of filing it twice. Owners are not something it can set: `risk_owner` and
  `action_owner` are profile ids, and those are assigned on the register screen.
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
- **It files tickets on «Дошка».** Say «створи тікет: …» and the ticket appears on the board
  — the board is not a Менеджмент section, so this works from any section, and «створи тікет»
  is never answered with a refusal. Four rules make the ticket worth having:
  - **The default board is the workspace's own.** «Задачі» is the board that always exists,
    needs no integration and no personal token, so a request that does not name a board lands
    there (`ticket.create`). The mirrored Jira board is opt-in BY NAME: only «створи в Jira…»
    routes to it (`jira.ticket.create`). Naming Jira in a workspace that has none — or on a
    machine with no personal Jira token — is refused with the reason, and NOT quietly filed on
    the native board instead: you named a board, and a card on the other one is a card you
    will not find where you looked.
  - **The ticket is written as a project manager writes one, and the app owns its shape.**
    The action carries five named slots — a business context, an optional user flow,
    acceptance criteria, an optional out-of-scope list, and the title — and
    `renderTicketDescription` turns them into the card body. So every ticket from this chat
    has the same headings in the same order, and there is no field in which a schema, an
    endpoint or a library could be specified: WHAT and WHY are the ticket's, HOW stays the
    team's. Before writing, the assistant reads the workspace's repositories to ground the
    ticket in what the product actually does today — but only the business conclusion reaches
    the card.
  - **A ticket never ships an open question.** If something is missing that only you can
    decide — the scope, an edge case, the assignee, which project — the assistant emits
    `ticket.questions` instead: the chat prints the numbered questions and states that the
    ticket was NOT created. Answer in the next message and it files the ticket; do not answer
    and there is no ticket. Belt and braces: a ticket whose text still contains «TBD»,
    «потрібно уточнити», a `<placeholder>`, a code fence or an acceptance criterion phrased as
    a question is refused in your browser with the offending fragment quoted back.
  - **Assignees are resolved, never guessed.** `tasks.assignee_id` is a profile id, so every
    turn carries the workspace roster by the same name the app shows you and the browser
    matches the name the ticket used back to that id. A name that matches nobody — or two
    people — refuses the ticket and lists the roster, rather than filing a card into nobody's
    queue. For Jira the same rule runs against Jira's own assignable users.
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

### Giving another section something it can write

The Risk Registry and Release Notes are wired end to end; every remaining section is `none`
or `read`, and the chat has no write path into them on purpose. Adding one is three edits,
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

One conversation per Воркспейс (`management:<workspaceId>`), held open as a git-free `omp`
child in the first bound repository of the group — or in your home directory when none is
bound — with no worktree, no branch and no row on the Агенти board. Switching workspace in
the sidebar switches conversation; «Новий чат» drops the child so the next question starts
from nothing. An idle conversation is stopped after a while, and the next message simply
spawns a fresh one.
