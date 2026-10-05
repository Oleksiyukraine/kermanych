# Native sessions: `omp` / `claude` in their own TUI

## Goal

Some operators do not want Kermanych's wrapper around the harness — they are used to the
original `omp` / `claude` and want exactly that, the way Warp or herdr host an agent: a
light frame around a session that lives in its native environment. Kermanych keeps what it
is good at (worktree/branch per task, the board, diff, PR, docs) and adds a thin, read-only
adapter per harness so it still knows what the session is doing.

Agreed with the operator (session `clear-omp-clear-claude-code`, 2026-10-05):

- The operator chooses **`claude` or `omp`** when launching. No plain-terminal variant.
- The pty runs the harness **directly** (`<login-shell> -lc 'exec …'`), no interactive
  shell; the harness exiting ends the session's run (`stopped`).
- **Nothing of Kermanych enters the agent's context**: no skills overlay, TTSR triggers,
  language/docs system-prompt append, co-author or docs directives, model/effort flags.
- A per-harness **adapter** only observes: start/resume command, status hooks passed as
  launch arguments (never installed globally), usage/history/PR link read from the
  harness's own session file.
- **App close** kills the harness; reopening continues it with `--resume`.
- **Helpers** (PR, commit, resolve conflict, docs) paste their prompt automatically only
  while the harness is idle; otherwise they are refused and the operator retries.
- Unchanged: `AgentRuntimeKind`, managed (headless) sessions, the management chat,
  release notes, `one-shot`.

## Context

- Managed sessions: `SupervisorService` (`apps/api/src/supervisor/supervisor.service.ts`)
  drives `omp --mode rpc` (`rpc/rpc-session.ts`) or the Claude Agent SDK
  (`runtime/claude-code-runtime.ts`) behind `AgentRuntime`, and renders the event stream
  as the Лог transcript.
- PTYs exist only for the project terminal (`terminal/terminal.service.ts`,
  `ws/terminal.gateway.ts`, spec `2026-09-29-project-terminal.md`): login shell, 256 KiB
  replay, `/terminal` socket.io namespace with bearer auth.
- Harness facts verified on this machine (claude 2.1.206, omp 18.4.8):
  - claude: `--settings <file|json>` hooks are **added** to the user's/project's hooks;
    `--session-id <uuid>` names the transcript; a positional prompt starts the TUI and
    submits it; hook stdin carries `session_id`, `transcript_path`, `hook_event_name`.
    A new untrusted folder shows a trust dialog first, and no hook fires until it is
    accepted. Transcript: `~/.claude/projects/<cwd with non-alphanumerics → '-'>/<uuid>.jsonl`;
    one API response spans several lines that repeat `message.id` and `usage`; there is
    no cost in the file.
  - omp: `--hook <file>` is an alias of `-e`; it loads **alongside** auto-discovered
    extensions; in the TUI `ctx.hasUI === true` and `ctx.sessionManager.getSessionId()` /
    `getSessionFile()` return the real id and `.jsonl` path. `omp launch [MESSAGES…]` is
    the default command (a bare prompt whose first word is a subcommand would be misread).
    Session file lines `{"type":"message","message":{role,content,usage{input,output,
    cacheRead,cacheWrite,cost{total}},model,stopReason,…}}`.

## Decisions

- **Data model: `Session.native: boolean` + the existing `runtime`.** `runtime` already
  names the harness (`omp` | `claude-code`) and is stamped at creation; `native` says it
  runs as a TUI. SQLite column `native INTEGER NOT NULL DEFAULT 0`. Live-only
  `Session.terminalId` names the running pty. Cloud cards are untouched: the mode is a
  launch choice, not a card field. Rejected: new runtime kinds (`clear-omp`…) — every
  `runtime === "claude-code"` branch would need rewriting and an older build would resume
  an unknown kind as omp.
- **Launch choice lives in the launcher** («Нова задача» → «Запустити»): a «Режим» control
  with `Керманич` (default) / `omp` / `claude`. Native hides model, effort and images (the
  harness's own `/model` is the place for them). «В беклог» and launches from the board
  stay managed.
- **PTY: `TerminalService.openSession`** spawns `<login-shell> -l -c 'exec "$@"' kermanych
  <file> <args…>` in the session's worktree with `shellEnv()` plus
  `KERMANYCH_NATIVE_URL` / `KERMANYCH_NATIVE_TOKEN`. Login shell for the Finder-launched
  `PATH`; `exec` so the harness replaces the shell and its exit is the pty's exit; `"$@"`
  so no argument is ever re-quoted. `TerminalInfo.sessionId` marks it; the project panel
  ignores such terminals. Windows is refused (`spawn_failed`) — the app ships for macOS.
- **Status transport: a per-session bearer secret over the local api.** `POST
  /api/native/:id/claude` (the raw hook JSON) and `POST /api/native/:id/omp` (a
  normalized event from the extension) are `@Public()` and check
  `Authorization: Bearer <token>` against the secret minted for that session's current
  launch (same model as `management-mcp`). The api listens on 127.0.0.1 only.
  - claude: one static settings file (`<tmp>/kermanych-native/claude-settings.json`) with
    `command` hooks `curl -sS -m 3 -o /dev/null … --data-binary @- "$KERMANYCH_NATIVE_URL/claude" || true`.
    `-o /dev/null` matters: a hook's stdout on `UserPromptSubmit`/`SessionStart` would be
    added to the agent's context. Exit code is always 0, and no output means no decision
    on `PermissionRequest`/`PreToolUse`. Rejected: `type: "http"` hooks (subject to a
    URL allowlist in the user's settings).
  - omp: one static extension (`<tmp>/kermanych-native/omp-native.js`) that is inert
    unless both env vars are set, skips subagents (`ctx.agent?.kind === "sub"`), and
    POSTs with `fetch`.
- **Status mapping** (the managed vocabulary, so buckets/dots/notifications just work):

  | claude hook | omp event | status |
  |---|---|---|
  | (launch with a prompt) | (launch with a prompt) | `queued` |
  | (launch without a prompt) | (launch without a prompt) | `done` |
  | `UserPromptSubmit` | `agent_start` | `thinking` |
  | `PreToolUse` (other tools) | `tool_execution_start` (not `ask`) | `tool` + `currentTool` |
  | `PostToolUse` | `tool_execution_end`, `tool_approval_resolved` | `thinking` |
  | `PreToolUse` `AskUserQuestion`/`ExitPlanMode`, `PermissionRequest`, `Notification` `permission_prompt`/`elicitation_dialog`/`elicitation_url_dialog`/`agent_needs_input` | `tool_execution_start` `ask`, `tool_approval_requested` | `waiting_input` |
  | `Stop` | `agent_end` | `done`, or `in_review` (below) |
  | — | `agent_end` with `stopReason: "error"` | `error` + message |
  | pty exit | pty exit | `stopped` |

  `in_review` follows the managed rule: the session already has a PR (`prOpened`), or a
  «Закоміти» helper is landing on it.
- **After every turn (`Stop` / `agent_end`)** the adapter reads the session file and
  writes: **usage** as an absolute total (`RegistryService.setUsage`; claude deduped by
  `message.id`, cost unknown → `0`; omp sums `usage.cost.total`), the **model** last used,
  the **PR link** (`PR_URL_RE`) when a «Створити ПР» helper armed it → `prOpened`, and a
  `transcript_reset` with the history. claude's file is read ~300 ms late — the `Stop`
  hook fires before the transcript is flushed.
- **History** (`GET /sessions/:id/transcript`, used by Сесія/Документація) is read from
  the file on demand: claude through the SDK's `getSessionMessages(uuid, {dir})` →
  `claudeHistoryToOmp`, omp by taking `.message` of `type: "message"` lines; both →
  `messagesToTranscript`. The Лог tab shows the TUI itself.
- **Session handles.** claude: Kermanych mints the uuid and passes `--session-id`; stored
  in `ompSessionId` (as for managed claude). omp: the extension reports
  `getSessionFile()` on `session_start`/`session_switch` → `ompSessionFile`.
- **Commands.**
  - claude start: `claude --session-id <uuid> --settings <file> [-- <prompt>]`;
    resume: `claude --resume <uuid> --settings <file> [-- <prompt>]` (settings are not
    restored on resume, so they are passed again).
  - omp start: `omp launch --hook <file> [-- <prompt>]`; resume:
    `omp launch --resume <sessionFile> --hook <file> [-- <prompt>]`; no file known yet →
    a fresh start.
  - The first prompt is the card's text only — no directives.
- **Helpers paste with bracketed paste**: `ESC[200~ text ESC[201~`, then `\r` 150 ms
  later, so a multi-line prompt is one message. Allowed while `done` / `in_review` /
  `error`; a stopped session is resumed with the prompt as the positional argument;
  anything else → `native_busy`. A pasted helper sets `queued` at once, so a second one is
  refused until a hook moves the session on. «Створити ПР» on a native session does not
  ask for the QA checklist block — there is no event stream to capture it from — and its PR
  scan only looks at history after the moment it was armed.
- **Handles follow the harness.** claude's `SessionStart` and omp's `session` event write
  back a changed id/file (`/clear`, `/resume`, `/new` inside the TUI), so «Продовжити»
  continues the conversation the operator last had open.
- **Lifecycle.** Stop/delete/finish kill the pty (SIGHUP, SIGKILL after 3 s); restart =
  kill, wait for exit, resume. The api writes `stopped` for running native rows on
  shutdown, and on start sets native rows left in an active status to `stopped` (their
  pty died with the previous process). The idle reaper does not apply.
- **Not available for native** (`native_unsupported`): model and effort changes,
  `/compact` and other harness commands from the composer, interactive answers
  (`answerUi`), discussion branch, review, images. The subagent map stays empty. The UI
  hides them.

## Changes

- `packages/core`: `Session.native`, `Session.terminalId`, `TerminalInfo.sessionId`;
  `ApiErrorCode` `native_busy`, `native_unsupported`.
- `apps/api`:
  - `registry/registry.service.ts` — `native` column, `createSession({native})`,
    `setUsage`.
  - `terminal/terminal.service.ts` — `openSession`.
  - `native/native-session.service.ts` — adapters, lifecycle, status, file readers.
  - `native/native-hooks.ts` — the claude settings and omp extension files.
  - `http/native.controller.ts` — the two hook routes.
  - `http/sessions.controller.ts` — `from-task` accepts `native?: AgentRuntimeKind`.
  - `http/session-failure.ts` — coded errors carry their `ApiErrorCode`.
  - `supervisor/supervisor.service.ts` — native branches in launch/deliver/stop/restart/
    resume/delete/finish/transcript and the refusals above; merge overlays native state.
  - `app.module.ts` — registers the service and controller.
  - `supervisor/pr-url.ts` — `PR_URL_RE`, now shared by the supervisor and the adapter.
- `apps/ui`: launcher «Режим»; Лог tab hosts the session's `KTerminalView` (or a
  «Продовжити» placeholder); composer and managed-only actions hidden for native; project
  terminal panel ignores session ptys (`lib/native-session.ts`); i18n uk/en.
- `kermanych/README.md` — «Native sessions» section.

## Verification

- Harness behaviour, real CLIs in a pty (claude 2.1.206, omp 18.4.8): `--` before the
  positional prompt works for `claude` and `omp launch`; the seven claude hook events are
  accepted from `--settings`; bracketed paste + `\r` 150 ms later submits one multi-line
  message in both TUIs; omp's `agent_end.messages` carries the assistant messages (the last
  one decides `error`).
- `apps/api`: `tsc --noEmit` clean; `vitest run` — 834 pass, 2 fail in
  `rpc-session.compact.spec.ts` (fail identically on `dev`). New: `native-session.spec.ts`
  (status tables for both harnesses, bearer refusal, file readers incl. claude dedupe by
  `message.id`, paste/busy/resume, after-turn PR/usage), `supervisor.native.spec.ts`
  (launch argv without directives, refusals, stale-row reset), and a real-pty
  `terminal.spec.ts` case proving `openSession` passes argv with spaces, quotes and `$HOME`
  through unexpanded. `packages/core` 186 pass. `apps/ui`: `vitest run` 536 pass (incl.
  i18n completeness, `native-session.spec.ts`); `vue-tsc` — only the pre-existing
  `test/runtime-messages.spec.ts` TS2352 and `src-electron/electron-main.ts` TS2307 (no api
  build output in a fresh worktree).
- End-to-end smoke, built api in preview mode (`KERMANYCH_PREVIEW=1`, isolated DB) + the
  preview UI in headless Chromium, two native rows on a throwaway git repo:
  - omp: a message to the stopped session started `omp launch … -- "<prompt>"`; status went
    `queued → thinking → done`; the row got `ompSessionFile`, model `claude-opus-5-5` and
    usage with cost `0.0049`. A two-line helper pasted while idle came back as one user
    message; a second helper during that turn got `400 {code: native_busy}`;
    `GET /transcript` returned both turns from the session file.
  - claude: the Лог tab showed the TUI with the trust dialog (status `у черзі`); Enter in
    the embedded terminal accepted it, the prompt ran, the header went to `claude ·
    нативно · готово` and the card moved to «Очікують». A prompt typed in the TUI showed
    `думає → готово`. Сесія: model `claude-haiku-4-5-20251001`, 62.6k tokens, no cost row,
    the claude session id. ⋯ → «Зупинити» → `зупинено` and the «Продовжити» placeholder;
    «Продовжити» resumed the same conversation (both earlier turns on screen).
  - The project terminal panel (`>_`) opened with only `1: zsh` — the session pty is not
    listed; the launcher «Режим» = claude hid model, effort and images.
  - Stopping the api wrote `stopped` on both rows and left no `claude`/`omp` process.

## Documentation impact

`kermanych/README.md` — new «Native sessions» section (how to launch, what Kermanych
tracks, what is unavailable, hooks are per-launch and leave user config untouched).
