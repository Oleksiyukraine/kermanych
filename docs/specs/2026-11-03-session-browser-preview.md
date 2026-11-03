# Session browser and live preview become one; preview config in the repo; project platform

Deep analysis, session 2026-11-03. The operator asked to rethink the session «Браузер» tab and
the «Налаштувати превʼю» button. Every decision below was settled with the operator, one
question at a time.

## Goal

- The live preview and the session browser become **one** feature in the «Браузер» tab. Starting
  and stopping the preview, its status and its logs all live there, next to the page.
- The agent of the session can start, stop and inspect the preview itself, and then check its
  work in the same page the operator sees.
- Preview commands move out of the cloud project row into a file in the repository, versioned
  with the branch.
- The platform moves from the task to the **project** (web / back-end / mobile / не визначено).
  Back-end and mobile projects get no browser and no preview at all.

## Context (before this change)

- **Session browser** (`docs/specs/2026-10-05-embedded-browser.md`,
  `2026-10-08-session-browser-rework.md`, `2026-10-26-close-session-browser.md`):
  - One Electron `WebContentsView` per session, desktop only. It is shown as the «Браузер» tab
    or beside the Лог (◫).
  - The agent drives it through the MCP server `kermanych` (`browser_*`). The operator points at
    elements with «◎ Вказати».
- **Live preview** (`apps/api/src/preview/preview.service.ts`, since 2026-08-09):
  - ▶ in the session header (`AgentsPage.vue:233-241`) runs an optional api command, then a web
    command, from the session directory on free ports.
  - The web URL is read from the dev server's banner.
  - Since 2026-10-05 the page opens in the session browser in the desktop app, and in a new
    system tab in the web build.
  - `browser_navigate` without a URL opens the running preview. The agent cannot start one.
- **Preview config:**
  - Two cloud columns, `projects.preview_command` / `api_command`.
  - They are edited in the «Налаштувати превʼю» modal (`AgentsPage.vue:1042-1064`, opened only
    by ▶ with no command, by `needsCommand`, or after a failed start) and in Settings → Проєкт →
    «Команди».
- **Problems found in the code:**
  - The modal's defaults are written for the Kermanych repo (`cd kermanych && pnpm install && …`,
    `AgentsPage.vue:3539-3541`), yet they are offered to every project.
  - Every project's api command gets `KERMANYCH_DB/SEED/PREVIEW` (`preview.service.ts:45-55`).
  - The modal writes team-wide config from a session, and cannot clear the api command.
  - A local-only project cannot be configured at all.
  - A crash after ready goes unnoticed (`:73`): ◼ stays, and the agent navigates to a dead URL.
  - Starts are not deduplicated in flight. The api child's stdout is never read.
  - Archive does not stop the preview (and an archived session has no ◼). A finished session's
    ▶ runs the main checkout.
  - The renderer keeps the only record of a running preview (`orchestrator.ts:74`), so a reload
    forgets it.
  - After ◼ the page stays on the dead port, and «Відкрити знову» later offers it again.
  - The only logs are 400 characters inside an error. A failure is shown with `window.alert`.
- **Platform** (`packages/core/src/platform.ts`):
  - Values `backend | web | mobile`, optional.
  - Picked per task in the launcher (`AgentsPage.vue:908-921`) and in the board editor
    (`BoardPage.vue:232-237`).
  - Set to `backend` by the API-request doc-task (`AgentsPage.vue:3515`), and offered to the
    management chat's `ticket.create`.
  - Stored in `tasks.platform` and copied to `sessions.platform`.
  - **Nothing reads it to change behaviour.** The board no longer shows it.

## Decisions

### 1. Direction: preview lives in the browser tab, and the agent can run it

Both halves: the operator controls and watches the preview in the «Браузер» tab, and the agent
gets tools to start, stop and read it.

Rejected:
- tab-only control without agent tools;
- agent-only control;
- fixing bugs without changing the UX.

### 2. Preview config is a file in the repository: `.kermanych/preview.json`

- **The only source.** It is read from the session directory: the worktree, or the main checkout
  for an in-place session. There is no other source and no fallback.
  - A finished session (no worktree) has no preview.
  - A branch that changes how the app builds carries its own preview config. The TS2307 story in
    `AgentsPage.vue:3532-3538` is exactly that case.
- **Removed:**
  - the cloud columns `projects.preview_command` / `api_command` (decision 9);
  - the «Налаштувати превʼю» modal;
  - the preview fields in Settings → Проєкт → «Команди». The section keeps only the session files
    (`carry_files`) and is renamed «Файли сесії».
- **Kermanych's own config moves into the repo.** The Kermanych repo gets its own
  `.kermanych/preview.json`, committed with this change. With it, the Kermanych-specific defaults
  and env leave the code.

Rejected:
- keeping the cloud columns (A);
- the repo file with the cloud as a fallback (C, as Conductor does with `.conductor/settings.toml`):
  two sources of truth.

### 3. File schema: one `setup` step and an ordered list of services

```json
{
  "setup": "cd kermanych && pnpm install && pnpm --filter @kermanych/api build",
  "services": [
    { "name": "api",
      "command": "cd kermanych && pnpm --filter @kermanych/api start",
      "env": { "KERMANYCH_DB": "${PREVIEW_DIR}/db.sqlite", "KERMANYCH_SEED": "1", "KERMANYCH_PREVIEW": "1" } },
    { "name": "web", "open": true,
      "command": "cd kermanych && pnpm --filter @kermanych/ui dev",
      "env": { "VITE_API_BASE": "http://localhost:${PORT_API}/api", "VITE_KERMANYCH_PREVIEW": "1" } }
  ]
}
```

- **`setup`** (optional): a shell command that runs before the services on every start, from the
  session directory. Timeout 20 min.
- **`services`** (at least one) start in order. Each one waits until the previous is ready
  (timeout 5 min each).
  - `name` matches `^[a-z][a-z0-9-]*$` and is unique.
  - `command` is required.
  - `env` is optional.
  - Exactly one service has `open: true`: its page is what the browser opens.
- **Variables that Kermanych provides to `setup` and every service:**
  - `PORT_<NAME>` for every service (upper case, `-` → `_`), each a free port;
  - `PORT`, the service's own port;
  - `PREVIEW_DIR`, a per-session temp directory
    (`$TMPDIR/kermanych-preview/<sessionId>/`). It is created before `setup` and deleted when the
    session is finished or deleted. Orphans are swept at api start.
  - `${VAR}` in `env` values expands only these variables; an unknown name makes the file invalid.
  - Commands run through `sh -c`, so they can use `$VAR` themselves.
- **Readiness.** A service is ready when its `PORT` accepts a TCP connection.
  - The `open` service is also ready when it prints an `http://localhost|127.0.0.1:<port>` URL
    (stdout **or** stderr) whose port accepts. This covers dev servers that ignore `PORT`.
  - Its URL is `http://localhost:<that port>`.
- **Validation.**
  - The file is parsed and validated before anything runs.
  - A missing file gives the state «не налаштоване».
  - An invalid file gives «файл превʼю з помилкою: …» with the exact field.

Rejected:
- two fixed roles `web` / `api` (A): this keeps the Vite-specific `VITE_API_BASE` and the
  Kermanych env in the code;
- one command plus a port block (C): logs get mixed, and repos need their own launcher.

### 4. Missing config: «Доручити агенту»

- **The button.** When the file is missing or invalid, the preview row offers «Доручити агенту».
- **What it sends.**
  - It calls `POST /sessions/:id/preview/configure` → supervisor
    `sendAsKermanych(id, previewConfigPrompt(error?) + skill block, "prompt")`.
  - This is the same path as «Написати хендоф» (`writeDoc`, `supervisor.service.ts:2882`).
  - The prompt carries the validation error when there is one.
- **The skill.** A new default skill `preview-config` in `packages/core/src/skills.ts`. Like any
  skill, it can be overridden per project, workspace or repo. It contains:
  - the schema and the variables;
  - the rules: idempotent `setup`, services bind `PORT`, one `open`, no secrets in the file;
  - the instruction to commit the file with the work and to try it with `preview_start`.
- **Who can use it.**
  - Only `agent` sessions (the same rule as `writeDoc`).
  - A native session takes it only while idle. Its refusal is shown in the preview row.

Rejected:
- a form in the tab that writes the file into the agent's worktree (it would conflict with the
  agent's uncommitted edits, and means another editor to keep);
- a hint only.

### 5. No limit on concurrent previews

- No cap and no priority change: today's behaviour.
- **Accepted risk:** agents can start dev servers on a shared machine without bound.

Rejected:
- a «Превʼю одночасно» limit in the machine resource profile, refusing (B) or evicting the oldest
  (C);
- an idle auto-stop (D).

### 6. One «Браузер» tab, in both builds

- **No preview controls outside the tab.**
  - No ▶ in the session header.
  - No preview modal.
  - No preview fields in Settings.
- **The preview row.** It sits under the browser toolbar and moves with the pane into «Поруч із
  логом». It holds:
  - the status: не налаштоване / файл з помилкою / setup… / запускається `<service>`… / працює /
    впало (`<service>`, код N) / зупинене;
  - service chips (`api :51234`, `web :51235`);
  - ▶ / ◼, ↻ (restart = stop + start), «Логи», and «Доручити агенту» when it applies.
- **«Логи»** opens a bottom panel inside the tab, with one tab per step (`setup`, then each
  service).
  - The page shrinks above it behind a draggable seam. The panel is never an overlay: the native
    view sits above the DOM and an overlay would freeze the page.
  - The panel opens on the failed step by itself after a failure.
- **Empty page state.**
  - «Запустити превʼю» is the primary button when the file is valid.
  - «Відкрити знову» stays for an ordinary last address.
  - The address bar works as before.
- **Starting navigates the page.** When a start (by the operator or the agent) becomes running,
  the session page navigates to the preview URL.
  - If the page was on the previous preview's origin, its path, query and hash are kept on the new
    port: `/settings` stays `/settings`.
  - The agent's navigation goes through the existing focus guard.
- **Tab indicator.** The tab label carries the preview status as a dot: spinner while starting,
  green while running, red when crashed or failed. The agent's pulsing «live» dot stays as it is.
- **Web build** (no embedded page):
  - the same «Браузер» tab with the same row and logs;
  - in place of the page, «У вебзбірці сторінка відкривається в окремій вкладці» and ⤤;
  - ▶ opens a placeholder tab inside the click and points it at the URL once running. This is
    today's popup-blocker trick.
- **The browser itself is unchanged:** address bar, ◎ Вказати, the agent pause, picks, dialogs,
  the ✕ on the tab (it closes the page, not the preview).

Rejected:
- a separate «Превʼю» tab (logs and page would never be visible together);
- keeping ▶ in the header as a shortcut (▶ already means four different actions in the app);
- dropping the preview from the web build;
- keeping the old ▶ in the web build.

### 7. Lifecycle and crashes

- **The API owns the state.**
  - `PreviewService` keeps a record per session from the moment a start begins. A second start
    while one is in flight returns the current state, so in-flight starts are deduplicated.
  - The state is part of the supervisor `snapshot()`, and changes are pushed on `events$`
    (`{ type: "preview", sessionId, state }`).
  - The renderer's own `previews` map is removed, so a reload shows the truth.
- **Stops by itself on:**
  - «Завершити»;
  - closing a merged session;
  - deleting a session by any path: the HTTP controller, the child cascade in `deleteSession`,
    and `removeProject`. The stop moves from the controller into the supervisor;
  - **archive** (new);
  - app quit.

  Stopping the agent, the end of its turn, and the ✕ on the tab do **not** stop it.
- **Stop.** SIGTERM to the process group, then SIGKILL after 5 s.
- **Crash.** Any service exiting while running stops the rest.
  - The state becomes «впало: `<service>`, код N».
  - Logs are kept until the next start.
  - **No automatic restart.**
- **On ◼ or a crash the page is left as it is.** The row turns grey or red.
- **After an app restart nothing comes back by itself.**
  - Main remembers the preview origin together with the session's last URL
    (`session-browser.json`).
  - When the last URL was on a preview origin that is no longer running, the empty pane offers
    «Запустити превʼю» instead of «Відкрити знову». The path is then kept, as above.
- **Logs.**
  - Every child's stdout and stderr are read (this fixes the api pipe that was never read),
    with ANSI stripped.
  - The last 2 000 lines are kept per step.
  - `GET /sessions/:id/preview/logs?step=&since=` returns them with a cursor. The logs panel polls
    it every second while it is open.

Rejected:
- restarting a crashed preview once (B), which hides the bug or loops;
- restarting only the crashed service (C): the other services keep pointing at its old port.

### 8. Which sessions get the preview

| Session | Preview (row, tools, «Доручити агенту») | «Браузер» tab | `browser_*` tools |
|---|---|---|---|
| agent (managed and native) | yes | yes | yes |
| discussion / review fork | no | plain browser, no preview row (as today) | no (as today) |
| chat | no | none (as today) | yes (as today) |

Rejected:
- removing the tab from forks (it would lose sending picks to a discussion);
- adding the tab and the preview to chats (ChatPage), which was not asked for.

### 9. Platform moves to the project

- **Values.**
  - `web`, `backend`, `mobile`, or none.
  - None is stored as `NULL` and shown as «Не визначено». Labels: Web / Back-end / Mobile /
    Не визначено.
  - Every existing project reads as «Не визначено» with no backfill.
- **Where it is chosen.**
  - The «Новий проєкт» modal (`MainLayout.vue:359-387`), default «Не визначено».
  - Settings → Проєкт → «Основне». It is locked for a local-only project, like every cloud field,
    and `publish()` copies it.
- **The gate.** `backend` and `mobile` turn off, for **every** session of the project:
  - the «Браузер» tab and «Поруч із логом»;
  - the preview;
  - `browser_*` and `preview_*`.

  `web` and «Не визначено» keep them.
- **Where the gate sits.**
  - In the MCP server's `tools/list` and `call()` (`browser-mcp.service.ts:399-402, 442-446`),
    **not** in `bindingFor`. The same server carries the findings tools and the minion's
    `report_outcome`, which must stay.
  - `POST /sessions/:id/preview` refuses as well.
- **Switching a project to back-end or mobile:**
  - its running previews stop;
  - the renderer closes its sessions' browser pages;
  - agents already running still list the tools, but their calls are refused.
- **Removed from the task:**
  - the launcher's platform segments;
  - the board editor's platform select;
  - the doc-task's automatic `backend`;
  - `platform` in the management chat's `ticket.create`: type, validator, prompt lines
    (`management-prompt.ts:143, 340`), and error code `ticket_platform_unknown`;
  - `publish-backlog`'s copy;
  - `Session.platform`;
  - the dead `CreateSessionDto` / `TaskDraft`.

### 10. Dropped columns: now, in this change

- **One migration does it all.**
  - It adds `projects.platform text`: plain text with no CHECK, like `default_effort`. The client
    reads an unknown value as «Не визначено».
  - It drops `projects.preview_command`, `projects.api_command` and `tasks.platform`.
  - It re-creates `tasks_guard()` without rule 6's `platform` lines
    (`20261023090000_task_auto_run.sql:107-112`).
- **Accepted risk:** a teammate on an older build cannot load the board or the project list until
  they update, because those builds select the dropped columns by name.
- **Local SQLite columns stay unused.** `projects.preview_command/api_command` and
  `sessions.platform` are no longer read or written, but they are not dropped. The registry has no
  `DROP` precedent, and the routines removal left local leftovers too. `projects.platform` is
  added the additive way.

Rejected:
- stop using the columns now and drop them after a release (B);
- keeping them forever (C).

### 11. The agent is not told to use the preview on its own

- The tools come with full descriptions, and the system prompt is unchanged.
- The agent starts a preview when it decides to, or when the task, the operator or a project skill
  asks.

Rejected:
- a system-prompt line for web projects (B);
- a default opt-in skill (C). It can be a later task.

## Agent tools (MCP server `kermanych`)

| Tool | Behaviour |
|---|---|
| `preview_start` | Reads and validates the file, then starts. With `restart: true` it stops first. Returns `running` (URL, services) once ready, or after 60 s returns `starting` (step) with a hint to call `preview_status`. A failure returns the failed step and the last 50 lines of its log. Navigates the session page as in decision 6. Already running → returns the running state. |
| `preview_status` | The current state. Optional `wait` (≤ 60 s) waits while it is `starting`. |
| `preview_stop` | Stops it. |
| `preview_logs` | `step` (`setup` or a service name) and `lines` (default 100, max 1 000). |
| `browser_navigate` | Unchanged, except that the «no preview» error now names `preview_start`. |

- **Queue.** The preview tools bypass the per-session browser queue, like `browser_dialog`, so a
  long start never blocks the page tools.
- **Pause.** The operator's «Агент» pause also refuses `preview_start` and `preview_stop`.
- **Trust.** The commands are code from the branch. The agent's own shell already runs with the
  same environment (`claude-code-runtime.ts:224` passes `process.env`), so the preview adds no new
  privilege.

## Changes (planned)

- **`supabase/migrations/20261103090000_project_platform_preview_file.sql`**: decision 10.
- **`packages/core`**:
  - `platform.ts`: the project platform type plus the gate helper;
  - `types.ts`: `Project.platform`, no `previewCommand` / `apiCommand`, no `Session.platform`, no
    dead DTOs;
  - `management-actions.ts` and `i18n-codes.ts`: no `platform`;
  - new `preview-config.ts`: file parser and validator, shared by api and ui;
  - `skills.ts`: the `preview-config` default skill.
- **`packages/cloud`**:
  - `projects.ts` and `types.ts`: `platform` in, preview columns out;
  - `tasks.ts`: `platform` out.
- **`apps/api`**:
  - `preview/preview.service.ts`: rewritten for the file, services, state, logs, crash detection,
    SIGKILL escalation, `PREVIEW_DIR`;
  - `http/sessions.controller.ts`: `GET /sessions/:id/preview`, `…/logs`, `POST …/configure`. The
    lifecycle stops move to the supervisor;
  - `supervisor.service.ts`:
    - stops on archive, finish, close-merged and every delete path;
    - the `configure` prompt;
    - stopping previews when the platform changes;
    - the snapshot and events;
    - no session platform;
  - `browser/browser-mcp.service.ts`: the preview tools, the platform and kind gates;
  - `registry.service.ts`: `projects.platform`, old columns ignored;
  - `management-prompt.ts`: no platform.
- **`apps/ui`**:
  - `components/kit/KBrowserPane.vue`: the preview row, the logs panel and the empty states. The
    row and the panel may become their own components;
  - `pages/AgentsPage.vue`:
    - removed: ▶, the modal, the launcher's platform, the doc-task platform, `previewBlocked`;
    - tab gating by platform and kind;
    - the tab dot;
    - the web-build tab;
  - `stores/orchestrator.ts`: preview state from the snapshot and events;
  - `stores/browser.ts`: close pages on a platform switch;
  - `src-electron/session-browser/browsers.ts`: the preview origin with the last URL;
  - `pages/BoardPage.vue`, `lib/tasks-view.ts`, `lib/publish-backlog.ts`, `stores/board.ts`,
    `stores/management-chat.ts`: no task platform;
  - `layouts/MainLayout.vue` (new-project platform), `pages/SettingsPage.vue` (platform field,
    «Файли сесії»), `lib/settings.ts`, `stores/projects.ts`;
  - `lib/api.ts`;
  - i18n uk/en.
- **Repo root**: `.kermanych/preview.json` for Kermanych itself.
- **Tests**: update `preview.spec.ts`, `browser-mcp.spec.ts`, the cloud `projects` / `tasks` specs,
  the management action / prompt / tickets specs, `tasks-view`, `publish-backlog`,
  `sessions.from-task`, `registry`. New cases only where listed under Verification.

## Verification (planned)

- **`apps/api` vitest:**
  - config validation (missing, invalid field, unknown `${VAR}`, two `open`);
  - ports and env per service, ordered readiness;
  - banner fallback on stderr;
  - in-flight dedupe;
  - crash after ready → `crashed` and the other services killed;
  - stop escalates to SIGKILL;
  - the log ring and cursor;
  - stops on archive, finish and cascade delete;
  - MCP `tools/list` by platform and kind, `call()` refusal, the preview tools.
- **`packages/cloud`**: mapping specs, plus the RLS/trigger suite against the local stack for the
  migration (`tasks_guard` without platform).
- **`apps/ui`**: `vue-tsc` and vitest.
- **Electron dev app** (`quasar dev -m electron`, preview mode, isolated DB), with a fixture repo
  whose `.kermanych/preview.json` has two services:
  - start from the row, and the page opens;
  - logs per step;
  - kill a service → red state, logs on the failed step;
  - ↻ keeps the path;
  - ◼ leaves the page;
  - an app restart offers «Запустити превʼю»;
  - a missing file → «Доручити агенту» → the agent writes the file and calls `preview_start`;
  - a `backend` project has no tab and no tools;
  - the web build tab;
  - Kermanych previewing itself with the committed file.

## Accepted risks

- **No limit on concurrent previews** (decision 5).
- **Older builds** cannot load the board or project list after the migration until they update
  (decision 10).
- **Projects lose their stored commands:** projects that had cloud preview commands have no
  preview until their branch carries `.kermanych/preview.json`. «Доручити агенту» covers it.

## Documentation impact

`kermanych/README.md`:
- «Session browser» is rewritten: the preview row, the logs, the tools, the platform gate.
- A new «Live preview» subsection covers the file schema, variables, lifecycle and
  «Доручити агенту».
- «Desktop app»: the preview sentence.
- The task launch params list (`:1007-1008`), the auto-run content list (`:327-328`) and the
  API-request card's platform (`:1339-1341`) lose the platform.
- Project creation and settings gain the platform.
