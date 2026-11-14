# «ШІ-команда → MCP-сервери»: the project's MCP servers, seen and edited in Kermanych

- **Date:** 2026-11-14
- **Status:** decisions agreed with the operator on 2026-11-14 (deep analysis); approved and
  implemented on this branch. Results at the end.
- **Scope:** `packages/core` (types, harness visibility, the codex mapping), `apps/api` (read,
  write, check, environment at launch), `apps/ui` (a new «ШІ-команда» section, i18n),
  `kermanych/README.md`.
- **Builds on:** `docs/specs/2026-10-22-skill-import.md` (repository content shown in
  «ШІ-команда»), `docs/specs/2026-11-04-session-env-and-tester-preview-gate.md` (the session's
  `.env`), `docs/specs/2026-10-16-native-codex.md` (codex trusts the session folder).

## Goal

MCP servers are becoming a normal part of a project. The operator wants Kermanych to make them
easier to manage, the way skills are: servers already configured in a project show up in
Kermanych, and a server added in Kermanych lands in the project's code, where every agent and
teammate gets it.

## Context (as-is)

- **Kermanych stores no project MCP servers.** Each harness reads its own files in the folder
  where it starts:

  | File in the repository | omp | claude | codex |
  | --- | --- | --- | --- |
  | `.mcp.json`, `mcp.json` | yes (fallback provider) | `.mcp.json` only | no |
  | `.omp/mcp.json` | yes | no | no |
  | `.claude/mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` | yes (imported) | no | no |
  | `.codex/config.toml` (`[mcp_servers.*]`) | yes (imported) | no | yes, trusted folders only |

  Sources: `omp://mcp-config.md`, Claude Code's MCP docs, codex's MCP docs. Kermanych already
  passes codex the session folder as trusted (`codexConfigArgs`).
- **Kermanych's own tools** (session browser, Jira, `improve_skill`) reach the harness only at
  launch, for one HTTP server: omp through `runtime/omp-mcp-bridge.ts` (omp has no CLI flag
  for MCP config), claude through `--mcp-config`, codex through `-c mcp_servers…`. This feature
  does not touch that path.
- **Secrets.** A committed file carries placeholders, not values. claude expands `${VAR}` in
  `command`, `args`, `env`, `url` and `headers`. omp expands it everywhere in `.omp/mcp.json`,
  and in root `.mcp.json` "in endpoint/auth fields" (whether stdio `args` count is unverified).
  codex has no `${VAR}`: a stdio server forwards variables by name (`env_vars`), an HTTP server
  takes `bearer_token_env_var` and `env_http_headers`.
- **Kermanych does not hand `.env` to the harness.** `rpc-session.ts` builds the child's env
  from `process.env` plus Kermanych's own keys. A native session gets the login shell's env. The
  project's `.env` (Settings → «Змінні середовища», `projects.controller.ts` `:id/env`) is copied
  into each new worktree (`carry_files`), and only the live preview reads it
  (`preview-dotenv.ts`).
- **Worktrees fork from `origin/<base>`** (`worktree.service.ts`). An uncommitted file in the
  bound checkout never reaches a new session.
- **Sessions start at the git root of the worktree.** For a project bound to a subfolder (this
  repository: `localRepoPath` = `…/Multiagent-app/kermanych`, git root `…/Multiagent-app`), the
  harness starts above `localRepoPath`.

### What the operator's projects show (2026-11-14)

| Project | Servers | Problem |
| --- | --- | --- |
| Platinum OS - BE | `dev-db`, `nestjs-docs` in `.mcp.json` | `dev-db` passes `${DEV_DB_RO_URL}` in `args`. That variable is in neither the project's `.env` nor the login shell, so the server cannot start in any session, and nothing says so. |
| Platinum OS - FE | `nextjs-docs` | Written by hand twice: in `.mcp.json` (claude, omp) and in `.codex/config.toml` (codex). |
| tik-tok/platinum-os | `playwright`, `shadcn` in `.mcp.json` | — |
| Multiagent-app | `project-docs` in `kermanych/.mcp.json` | The file sits in the bound subfolder, while sessions start at the git root. Kermanych's own sessions do not get `project-docs`. |

So three things hurt: nobody sees which servers a project has or whether they work; each
harness needs its own file; and a `${VAR}` placeholder has no value unless the operator's shell
happens to export it.

## Decisions

### 1. The repository file is the only copy

Kermanych is a viewer and editor over the project's MCP files. It keeps no cloud table and
injects no server at launch. Every harness, teammate and CI run gets a server through git, as
they do today.

*Rejected:* a cloud library like `ai_skills` (user / project / workspace rows), with import and
«write to repository». Two copies drift as soon as someone edits the file outside Kermanych.
Delivering library rows to omp would also need a generated extension package, because omp reads
MCP only from files. *Rejected:* automatic two-way sync between cloud and file, because a
conflict has no clear winner.

### 2. Project scope only, in a new «ШІ-команда» section

- A new rail group **«Інструменти»** with one section, **«MCP-сервери»** (`/ai-team/mcp`). At
  user and workspace scope the pane says that MCP servers live in a project's repository and
  asks the operator to pick a project. The same pattern is used where a scope has nothing to show.
- A project with no checkout on this machine (`localRepoPath` empty) shows «Проєкт не
  привʼязано до теки на цій машині».
- **Who may edit:** whoever has the checkout on this machine. The write is a local file change.
  Review happens in git, so no cloud permission applies (unlike the skill library, which is
  workspace-owner only).

### 3. Where the files are read and written: the checkout's git root

Kermanych reads and writes the files at `git rev-parse --show-toplevel` of `localRepoPath`,
because that is where every session's harness starts. For almost every project this is
`localRepoPath` itself. A server file found only under `localRepoPath` when that path is a
subfolder is listed with «Сесії Керманича цей файл не бачать» and a «Перенести в корінь»
action. That action copies the server into the root `.mcp.json` and removes it from the subfolder
file.

### 4. What the list shows

The list holds one row per server name, merged across all the files in the table above:

- the name, the kind (local command or URL), and the command or URL itself, with the values of
  secret placeholders never expanded;
- the files that define it;
- **which harness sees it:** omp, claude and codex chips, computed from the file table. A
  server in `.cursor/mcp.json` only shows omp alone, for example;
- **variables:** every `${VAR}` (and codex `env_vars` / `bearer_token_env_var` /
  `env_http_headers` name) it needs, each marked «задано в .env», «задано в оточенні» or
  «не задано». A server with an unset variable shows a warning on its row;
- **«не закомічено»**, when `git status --porcelain` lists `.mcp.json` or `.codex/config.toml`
  in the checkout, with the note that new sessions get the change after it is committed and
  pushed to the base branch, and that running sessions do not get it until they restart.

### 5. Editing writes `.mcp.json` and mirrors it into `.codex/config.toml`

- **«Додати»**, **«Змінити»** and **«Видалити»** act on root `.mcp.json`, the one file claude
  and omp both read. A server that exists only in another file (`.cursor/mcp.json`,
  `.codex/config.toml`, …) is read-only and gets **«Скопіювати в .mcp.json»**. This is the
  "existing settings come into Kermanych" path. It changes nothing in the other file.
- **The form:** name, kind (local command / URL); command and arguments, or URL; environment
  variables (stdio) or headers (HTTP). Each value has a «секрет» toggle (decision 6). Fields
  the form does not know (`timeout`, `enabled`, `oauth`, `$schema`, …) are kept as they are on
  save. Names follow `^[A-Za-z0-9_-]{1,64}$`, the set all three harnesses accept. A name already
  in `.mcp.json` is refused.
- **The codex mirror.** On every save or delete, Kermanych writes the same server into
  `[mcp_servers.<name>]` of `.codex/config.toml` (creating the file if needed), or removes it.
  It translates as follows:

  | `.mcp.json` | `.codex/config.toml` |
  | --- | --- |
  | `command`, `args` without placeholders | `command`, `args` |
  | `env: { KEY: "literal" }` | `env = { KEY = "literal" }` |
  | `env: { KEY: "${KEY}" }` | `env_vars = ["KEY"]` |
  | `url` without placeholders | `url` |
  | `headers: { Authorization: "Bearer ${T}" }` | `bearer_token_env_var = "T"` |
  | `headers: { X: "${V}" }` (the whole value) | `env_http_headers = { X = "V" }` |
  | `headers: { X: "literal" }` | `http_headers = { X = "literal" }` |

  When the server cannot be translated (a placeholder in `args` or `url`, `env: { A: "${B}" }`,
  or a header with text around the placeholder), there is no codex table for it, and the row's
  codex chip says why («codex не підставляє змінні в аргументи»). `dev-db` is such a case.
  *Rejected:* wrapping the command in `sh -c` so that codex expands the variable. It changes the
  server's process and quoting for every harness.
- **codex tables Kermanych did not write.** If `[mcp_servers.<name>]` already exists and differs
  from the translation, saving shows the difference and asks before replacing it. Everything
  else in `.codex/config.toml` (other servers, comments, other settings) is left byte for byte:
  Kermanych replaces only that table and its subtables in the text, and parses the file only to
  find them.
- **Nothing commits.** Kermanych never runs `git commit` on the bound checkout, which may be on
  any branch and hold unrelated changes. The «не закомічено» mark (decision 4) is the hand-off.
  *Rejected:* auto-commit and push to the base branch; copying `.mcp.json` into new worktrees
  through `carry_files` by default, which makes every session branch carry a diff the agent may
  commit. An operator may still add `.mcp.json` to «Файли для копіювання» themselves.

### 6. Secrets: `${VAR}` in the file, the value in `.env`, and Kermanych passes it at launch

- **In the form,** a value marked «секрет» (the default for env values and headers) writes
  `${KEY}` into `.mcp.json` and writes the value into the checkout's `.env` through the existing
  `EnvFileService`. For a header, `KEY` is suggested from the server and header name, for
  example `LINEAR_AUTHORIZATION`, and the operator can edit it. An `Authorization: Bearer …`
  value is stored without the `Bearer ` prefix, so that the codex mapping above applies. An
  unset variable on the list can be filled in inline, which writes to the same `.env`.
- **At launch,** Kermanych reads the `.env` in the session's folder (the worktree, or the
  checkout for a chat). It takes only the variables the MCP files of that folder reference
  (decision 4's list) and adds them to the harness's environment. A value from `.env` wins over
  an inherited one. This covers every harness launch Kermanych makes in a project folder: managed
  omp sessions (`rpc-session.ts` `env`), native sessions and chats (the pty env), «Посіпака»,
  «Тестувальник», and scheduled runs.
  - *Why only referenced variables:* the agent can already read `.env` as a file. Copying the
    whole file into the process env would also hand it to every subprocess, and to every MCP
    server through inheritance.
  - *Native sessions:* this is environment, not context, so it does not break «nothing of
    Kermanych enters the agent's context». README's native-sessions section gets one line about
    it.
- **Existing worktrees** keep their own `.env` copy. A value saved in this section reaches new
  sessions. A running session needs «Змінні» in its preview row and a restart, and the section
  says so.

### 7. «Перевірити»

Each row has a «Перевірити» button. The api starts the server the way a session would: in the
checkout's git root, with `process.env` plus the referenced `.env` variables. It sends
`initialize` and `tools/list`, then stops it.

- stdio: the process is spawned in its own group and killed together with its children
  (`runtime/process-group.ts`). The time limit is 60 s, because `npx -y` downloads on first use.
- HTTP: `initialize` is a POST with the configured headers. A 401 or 403 answer shows «Сервер
  вимагає входу (OAuth). Увійдіть у самому harness: `/mcp` в omp або claude, `codex mcp login`».
  Kermanych does not do OAuth.
- The result is the list of tool names with their descriptions, or the error and the last
  stderr lines. It is kept in memory until the file changes, and nothing is stored.
- A server with an unset variable is still checked, because the server's own error says the
  most.
- A minimal JSON-RPC client in the api (newline-delimited stdio, HTTP POST that accepts JSON and
  SSE answers), the same size as the bridge's. No MCP SDK dependency.

### 8. Not in this version

- A catalog of popular services with one-click add (Playwright, Postgres, GitHub, Sentry,
  Linear…).
- Workspace-wide or personal (home-folder) servers. `~/.claude.json`, `~/.omp/agent/mcp.json`
  and `~/.codex/config.toml` are not shown.
- OAuth sign-in through Kermanych.
- Showing which MCP servers a running session actually connected to.

## Changes

- **core** (`packages/core/src/mcp.ts`, new)
  - Types: `McpServerDef` (stdio | http, plus pass-through unknown fields), `McpSourceFile`,
    `McpServerRow` (name, def, files, `seenBy: { omp, claude, codex }`, `codexMirror: ok |
    { reason }`, `vars: { name, state: "env-file" | "process" | "unset" }[]`, `uncommitted`),
    `McpCheckResult`.
  - Pure functions: `mcpVarRefs(def)` (every `${VAR}`/`${VAR:-x}` name),
    `toCodexTable(def)` → table or a reason, `seenBy(files)`, `MCP_NAME_RE`.
- **api**
  - `mcp/mcp-files.ts`: read the seven files at the git root (and under `localRepoPath` when it
    is a subfolder); JSON read and write that keeps unknown keys and two-space indentation; the
    text-level replacement of one `[mcp_servers.<name>]` table in TOML. A TOML parser is added
    to find tables: `smol-toml`, a direct `apps/api` dependency.
  - `mcp/mcp.service.ts`: `list(projectId)`, `save(projectId, name, def, secrets)`,
    `remove`, `copyToMcpJson`, `moveToRoot`, `check`. It writes `.env` through `EnvFileService`.
  - `mcp/mcp-check.ts`: the stdio and HTTP check client (decision 7).
  - `mcpLaunchEnv(dir)` (in `mcp/mcp-files.ts`) → the referenced `.env` variables. It is called
    at the two spawn points every launch in decision 6 goes through: `RpcSession.start()`
    (managed omp: sessions, chats, «Посіпака», «Тестувальник», scheduled and one-shot runs) and
    `NativeSessionService.doStart()` (native sessions and chats). It reads synchronously, so the
    spawn stays in the same tick as `start()` (the renice contract `rpc-session.config.spec.ts`
    pins).
  - `http/mcp.controller.ts`: `GET /projects/:id/mcp`, `POST /projects/:id/mcp`,
    `PUT /projects/:id/mcp/:name`, `DELETE /projects/:id/mcp/:name`,
    `POST /projects/:id/mcp/:name/copy`, `POST /projects/:id/mcp/:name/move-to-root`,
    `POST /projects/:id/mcp/:name/check?location=`. A write answers `{ view }`, or
    `{ conflict: { current, next } }` when it stopped at a differing codex table (a 200, not a
    409: the UI needs both tables, and the api client keeps no error body). These are behind the
    global auth guard and touch no cloud.
- **ui**
  - `lib/ai-team.ts`: the group `tools` and the section `{ key: 'mcp', group: 'tools' }`.
  - `components/settings/McpServersPanel.vue` (list, chips, variables, «не закомічено»,
    «Перевірити»), `McpServerEditor.vue` (the form and the codex-difference confirm).
    `AiTeamPage.vue` routes the section, with the user- and workspace-scope note.
  - Async states follow README → Design → Async states: `useLoadPhase` + `KSkeleton` for the
    list, and `useAsyncAction` for save, delete, copy, move and check.
  - i18n keys (uk/en) for every string.
- **docs:** `kermanych/README.md` gets `### MCP servers («ШІ-команда → MCP-сервери»)` after
  «Skills»: the files and who reads them, the codex mirror and its limits, secrets through
  `.env`, «не закомічено», and the routes. The native-sessions section gets one line on the MCP
  variables passed at launch.

No migration and no cloud changes.

## Measured during implementation, before the UI

These are claims from documentation that decisions rest on, so they are tested on real runs
first:

1. omp expands `${VAR}` in stdio `args` of root `.mcp.json`. Test: a temp project whose
   `.mcp.json` runs a tiny server that echoes its argv; launch `omp` with the variable set; check
   the tool's output. If omp does not expand it, the codex-style rule applies to omp too (the
   chip says so), and the README states it.
2. When the same name is in `.mcp.json` and `.codex/config.toml`, omp uses one of them and does
   not show two. Test: `/mcp list` in a temp project.
3. codex reads project `.codex/config.toml` with Kermanych's trust override, and forwards
   `env_vars` from the env Kermanych sets. Test: a native codex session on a temp project.
4. claude picks up the variable from the pty env Kermanych sets (not only from the login
   shell). Test: a native claude session with `dev-db`-like `${VAR}` args.

## Verification

- **core:** `mcpVarRefs` (default syntax, several placeholders in one value); `toCodexTable`
  for each row of the mapping table and each "cannot translate" case; `seenBy` for each file.
- **api** (temp dirs, one run, `--maxWorkers=4`): list merges a server defined in two files;
  save keeps unknown keys; the codex table replacement keeps the rest of the file byte for byte;
  an existing differing codex table is reported, not overwritten; a secret goes to `.env` and
  `${KEY}` to the file; `mcpLaunchEnv` returns only referenced keys and `.env` wins;
  `uncommitted` follows `git status`; check against a tiny stdio server (tools listed) and a
  process that exits (error and stderr shown), and the group is gone afterwards.
- **Smoke** (preview, signed in):
  1. Platinum OS - BE: `dev-db` shows omp and claude, codex «не підставляє змінні в
     аргументи», and `DEV_DB_RO_URL` «не задано».
  2. Platinum OS - FE: `nextjs-docs` is one row with both files and all three chips.
  3. Add a test server with a secret header on a scratch project: `.mcp.json` holds `${…}`,
     `.env` holds the value, `.codex/config.toml` holds the mapped table, and the row shows
     «не закомічено». «Перевірити» lists its tools.
  4. A native claude session on that project lists the server's tools in `/mcp`.
- **Typecheck:** `apps/api`, `apps/ui`.

## Documentation impact

`kermanych/README.md`: the new section and one line in «Native sessions» (see Changes). No
migration and no cloud runbook.

## Results (2026-11-14)

### Measurements

1. **omp expands `${VAR}` in stdio `args` and `env` of root `.mcp.json`.** A probe server that
   logs its argv, launched by `omp -p` 18.20.0 with `PROBE_ARG=argval`, got
   `["mcpjson","argval"]`.
2. **omp starts a same-named server once, and the codex table wins.** With the probe in both
   `.mcp.json` and `.codex/config.toml`, omp launched only the codex variant (`argv: ["codex"]`).
   So for omp the codex mirror is the definition that runs. This is harmless because the mirror is
   an exact translation, and it is one more reason a differing hand-written table is shown and
   confirmed.
3. **codex: not measured.** The codex CLI is not installed on this machine. Project
   `.codex/config.toml`, `env_vars`, `bearer_token_env_var` and `env_http_headers` rest on codex's
   own documentation.
4. **claude expands `${VAR}` from its process environment.** `claude -p` 2.1.285 with
   `enableAllProjectMcpServers` started the probe with `["mcpjson","argval"]` and
   `PROBE_ENV=envval`. The pty env Kermanych sets is that process environment.

### Checks

- `@kermanych/core`: 486 passed (`mcp.spec.ts` adds 17). `@kermanych/api`: `tsc --noEmit` clean;
  `mcp.spec.ts` (12), `rpc-session.config.spec.ts` and `native-session.spec.ts` pass.
  `@kermanych/ui`: `vue-tsc` clean; `mcp.spec.ts` (10), `ai-team.spec.ts` and the i18n suites
  pass.
- **Smoke** (preview api and `quasar dev`, a scratch checkout bound as the seeded «Acme Web»,
  shaped like the operator's projects):
  - `nextjs-docs` in `.mcp.json` and `.codex/config.toml`: one row, both files, all three marks.
  - `dev-db` with `${DEV_DB_RO_URL}` in `args`: omp and claude, «codex його не отримає: codex не
    підставляє змінні в аргументи», the variable «не задано». «Перевірити» showed «the server
    exited (code 1)» and the postgres server's `TypeError: Invalid URL … input: ''`. «Задати»
    wrote the value to `.env`, and the row turned «задано в .env».
  - A `.cursor/mcp.json`-only server: omp alone. «Перевірити» listed 16 tools of
    `server-everything` in 2.5 s. «Скопіювати в .mcp.json» wrote it to `.mcp.json` and the codex
    table, and «не закомічено» appeared.
  - «Додати сервер» → URL `https://mcp.linear.app/mcp`, header `Authorization` with
    `Bearer lin_api_demo123` as a secret: `.env` got `LINEAR_AUTHORIZATION=lin_api_demo123`,
    `.mcp.json` `Bearer ${LINEAR_AUTHORIZATION}`, and codex `bearer_token_env_var`.
    «Перевірити» answered HTTP 401 with the OAuth hint.
  - A hand-edited codex table (`@1.2` and `startup_timeout_sec = 30`): the row said it differs,
    «Зберегти» showed both tables, «Замінити й зберегти» replaced the args and kept
    `startup_timeout_sec`, the comment and the other tables.
  - The user scope shows «MCP-сервери зберігаються в репозиторії проєкту. Оберіть рівень
    «Проєкт»».
- **Not exercised:** a real session on the operator's own projects, which the preview cannot
  reach. In the preview, `npm` inside «Перевірити» printed `npm warn Unknown env config` lines,
  because the preview api runs under `pnpm` and inherits its `npm_config_*` variables.
