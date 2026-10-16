# Native `codex`: a third harness in its own TUI

## Goal

The launcher «Режим» and the «Чат» mode chip offer `Керманич` (managed) and two native
harnesses, `omp` and `claude` (`docs/specs/2026-10-05-native-sessions.md`,
`docs/specs/2026-10-06-native-chats.md`). The operator asked for `codex` (and possibly
`cursor`) next to them (session `add-codex`, 2026-10-16).

Agreed with the operator:

1. **Native only.** `codex` becomes a native harness exactly like `omp` / `claude`. No
   managed codex runtime: onboarding, the account backend preference, the model catalog,
   runtime-check and managed sessions are unchanged. A managed codex (or cursor) is a
   separate task.
2. **`codex` now, `cursor` later.** Cursor could not be verified on this machine (stale
   `cursor-agent` 2025.09.12 without hooks, not signed in). Its researched facts are kept
   below (Appendix) as the starting point of that task. The adapter is built for N
   harnesses so cursor is an additive change.
3. **A separate native-harness vocabulary** (`NATIVE_HARNESSES`), not a new
   `AgentRuntimeKind`.
4. **`codex` is found on `PATH` only**, like `claude` / `omp`. No fallback to the copy
   bundled in ChatGPT.app, no launch preflight: a missing binary prints `command not found`
   in the session's terminal and the run ends `stopped`.
5. **Hook trust: Kermanych pre-trusts only its own hooks** with a computed `trusted_hash`
   passed on the command line. Nothing is written to `~/.codex/config.toml`.
6. **The folder-trust dialog is always skipped** (worktree and chat checkout), by an inline
   `projects` override on the command line; nothing is written.
7. **Native codex chat is read-only by sandbox**: `-s read-only -a never`.
8. **Status comes from hooks only**, including codex's `Interrupt` hook (codex ≥ 0.163). A
   turn that ends in an error has no hook; the gap is documented, not worked around.
9. **codex gets the session MCP server** (session browser + findings) on the same terms as
   claude / omp.
10. **git in the worktree: nothing added at first.** The operator's codex sandbox applies;
    if the smoke shows the commit helpers cannot work even after approval, `--add-dir` is
    examined and brought back to the operator with the facts.

## Context

- `apps/api/src/native/native-session.service.ts` is the per-harness adapter: argv
  (`command()`), hook handlers (`claudeHook`, `ompEvent`), file readers (usage, model,
  history), handle columns. Every branch is `session.runtime === "claude-code" ? … : omp`.
  `native/native-hooks.ts` writes the launch-argument hook artefacts;
  `http/native.controller.ts` has one route per harness.
- The native choice is typed `AgentRuntimeKind` (`packages/core/src/runtime.ts`,
  `AGENT_RUNTIMES = ["omp","claude-code"]`) and validated with `isAgentRuntime` at
  `POST /sessions/chat` and `POST /sessions/from-task`. The same type drives the account
  preference, `KERMANYCH_RUNTIME`, runtime-check, the model catalog and `createRuntime`
  (`kind === "omp" ? RpcSession : ClaudeCodeRuntime` — any other kind silently becomes
  claude). `packages/core/src/types.ts` repeats the union by hand (`AgentRuntime`; open
  finding).
- An older build maps an unknown `sessions.runtime` to `undefined` (falls back to omp) and
  NULLs it on its next `updateSession`; `readSessionReport` drops a cloud card's report
  whose `runtime` it does not know.
- UI: `apps/ui/src/lib/native-session.ts` (`LaunchMode = "managed"|"omp"|"claude"`,
  `nativeRuntimeFor`, `nativeHarnessName`, `sessionLaunchMode`, `sessionCostKnown`),
  `KHarnessMark.vue`, the launcher in `AgentsPage.vue`, the chip in `ChatPage.vue`, i18n
  `agents.native.*`.

### codex facts (verified on this machine)

Live pty smoke on `codex-cli 0.147.0-alpha.1.2` (bundled in `/Applications/ChatGPT.app`,
ChatGPT auth), in throwaway git repos with a temporary `CODEX_HOME`; `codex-cli 0.163.0`
(npm `latest`) inspected from its package. Sources: `codex --help`, the binary,
`codex-rs/hooks/src/engine/discovery.rs`, `codex-rs/config/src/fingerprint.rs`,
https://developers.openai.com/codex/hooks.

- **Install.** `npm i -g @openai/codex` / `brew install codex`. Not on `PATH` here.
- **argv.** `codex [OPTIONS] [-- PROMPT]`; `codex resume [OPTIONS] <SESSION_ID> [-- PROMPT]`
  (options before the id). `--` works for both; a prompt opening with `--` is submitted
  as text. No `--session-id`: codex mints a UUIDv7 itself.
- **Hooks** are a `[hooks]` table per config layer; layers add up. They can be passed only
  on the command line, one `-c` per event:
  `-c 'hooks.Stop=[{hooks=[{type="command",command="…",timeout=5}]}]'`. Events (0.163):
  `PreToolUse PermissionRequest PostToolUse PreCompact PostCompact SessionStart SessionEnd
  UserPromptSubmit SubagentStart SubagentStop Stop Interrupt` (0.147 lacks `Interrupt` and
  ignores an unknown event key). Hooks run in the session cwd with codex's environment, so
  `KERMANYCH_NATIVE_URL` / `KERMANYCH_NATIVE_TOKEN` reach them. Plain stdout of
  `SessionStart` / `UserPromptSubmit` is injected into the model's context, and exit 2
  blocks or denies, so the hook must print nothing and always exit 0. Hooks are
  synchronous.
- **Hook payload (stdin).** Common: `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model`, `permission_mode`. `SessionStart` +`source`
  (`startup|resume|clear|compact|fork`); `UserPromptSubmit` +`turn_id`, `prompt`;
  `PreToolUse` +`tool_name` (`Bash`, `apply_patch`, `mcp__<srv>__<tool>`), `tool_input`,
  `tool_use_id`; `PostToolUse` +`tool_response`; `PermissionRequest` +`tool_name`,
  `tool_input`; `Stop` +`last_assistant_message`. `SessionStart` fires lazily — on the
  first submitted prompt, not when the TUI opens.
- **Hook trust.** Hooks from `-c` are skipped until trusted: a startup modal «Hooks need
  review», whose «Trust all» writes `[hooks.state."<layer>:<event>:<group>:<handler>"]
  trusted_hash` into `~/.codex/config.toml`. Passing that `hooks.state` table with `-c`
  instead skips the modal and writes nothing (verified). `trusted_hash` =
  `"sha256:" + hex(sha256(JSON))` of `{"event_name":"<snake>", ["matcher":…],
  "hooks":[<normalized handler>]}` serialised compact with sorted keys, e.g.
  `{"event_name":"stop","hooks":[{"async":false,"command":"…","timeout":5,"type":"command"}]}`
  (reproduced codex's own value for `stop`, `session_start`, `pre_tool_use`,
  `permission_request`). `<layer>` is the synthetic path codex gives the `-c` layer. The
  algorithm is internal. `--dangerously-bypass-hook-trust` also skips the modal but runs
  every untrusted user/project hook too and prints a warning on each start.
- **Folder trust.** A new folder asks «Do you trust the contents of this directory?»; Enter
  writes `[projects."<path>"] trust_level` into `~/.codex/config.toml`. The inline-table
  override `-c 'projects={"<realpath>"={trust_level="trusted"}}'` skips it and writes
  nothing (the dotted form does not). The path must be the realpath (`/private/tmp/…`).
- **Session file** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` (=
  `transcript_path`), created at TUI start. Lines `{timestamp, type, payload}`:
  - `session_meta` — `id`, `cwd`, `cli_version`, `originator`.
  - `turn_context` — one per turn, `model`, `effort`, `approval_policy`, `sandbox_policy`.
  - `event_msg` `token_count` — `info.total_token_usage{input_tokens, cached_input_tokens,
    cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`,
    cumulative across resume; `input_tokens` includes `cached_input_tokens`; `info` may be
    `null`. No cost (ChatGPT plan).
  - `event_msg` `user_message` — the clean prompt (`message`). `response_item` user
    messages also carry injected blocks (`<environment_context>` …); `developer` messages
    are system injections.
  - `response_item` `message` role `assistant`, `content[{type:"output_text",text}]`.
  - Tools: `response_item` `function_call{name, arguments(JSON string), call_id}` +
    `function_call_output{call_id, output}`, and `custom_tool_call{name, input, call_id}`
    + `custom_tool_call_output{call_id, output}`; `output` is a string or
    `[{type, text}]`. `reasoning` items are encrypted.
  - `event_msg` `turn_aborted{reason:"interrupted"}` on Esc.
  At `Stop` the turn's last `token_count` and assistant message are already in the file.
- **Handle changes.** `/new` → next prompt's `SessionStart` `source: "startup"` with a new
  `session_id`; `/resume` → `source: "resume"` with the chosen id. Every hook carries the
  current `session_id` / `transcript_path`.
- **Bracketed paste** (`ESC[200~ … ESC[201~`, `\r` 150 ms later) submits one multi-line
  message.
- **Read-only.** `-s read-only -a never`: `echo hi > x.txt` fails «operation not
  permitted», nothing is written, no escalation is offered. There is no tool allowlist:
  read-only shell commands run; MCP / plugins / apps are outside the shell sandbox.
- **Approvals.** `PermissionRequest` fires right before the approval modal; after approval
  the next event is `PostToolUse`.

## Decisions

### D1. Vocabulary: `NATIVE_HARNESSES`

- `packages/core/src/runtime.ts` gains `NATIVE_HARNESSES = ["omp", "claude-code", "codex"]
  as const`, `type NativeHarness`, `isNativeHarness`. `AGENT_RUNTIMES` /
  `AgentRuntimeKind` stay the managed backends.
- `Session.runtime` (and the hand-written `AgentRuntime` in `types.ts`,
  `SessionReport.runtime`) widen to `NativeHarness`; `sessions.runtime` stays free TEXT,
  and the registry guards it with `isNativeHarness`. `readSessionReport` accepts native
  harnesses.
- Managed code paths (`createRuntime`, `ModelsService`, account preference,
  `KERMANYCH_RUNTIME`, runtime-check, one-shot) keep `AgentRuntimeKind`. Where a session's
  runtime feeds them, one helper narrows `Session.runtime` to `AgentRuntimeKind` and throws
  on a native-only harness — unreachable, because native rows never take managed paths, but
  the compiler now proves no other spot can pass `codex` on.
- `POST /sessions/chat` and `POST /sessions/from-task` validate `native` with
  `isNativeHarness` (`400 unknown native harness` otherwise); `createChat` /
  `createSessionFromTask` take `NativeHarness`.
- The adapter's per-harness parts become a `Record<NativeHarness, …>` (argv builder, hook
  handler, usage reader, history reader, session-file path) instead of the binary
  `=== "claude-code"` ternaries, so a harness without an implementation does not compile.
- Rejected: `"codex"` in `AGENT_RUNTIMES` — it would become a valid account preference,
  `KERMANYCH_RUNTIME` and runtime-check input, and `createRuntime` would silently run it as
  claude; each needs a separate guard.
- Accepted limit: an older build reads a codex row's runtime as `undefined`, so «Продовжити»
  there would start omp, and it hides that card's «Сесія» report. Only on a downgrade.

### D2. Binary

`codex` from the login shell's `PATH`, as for claude / omp. No bundled-copy fallback (an
alpha that updates with ChatGPT, at a path inside a third-party bundle), no preflight.

### D3. Commands

```
start:  codex  <common> [<chat>] [-- <prompt>]
resume: codex resume <common> [<chat>] <sessionId> [-- <prompt>]
common: -c 'projects={"<realpath cwd>"={trust_level="trusted"}}'
        -c 'hooks.<Event>=[{hooks=[{type="command",command="<hook>",timeout=5}]}]'   (per event)
        -c 'hooks.state={"<layer>:<event>:0:0"={trusted_hash="sha256:…"}, …}'
        [-c 'mcp_servers.<name>={url="<url>",bearer_token_env_var="<MCP_TOKEN_ENV>"}']
chat:   -s read-only -a never
```

- Resume when the row has a codex session id; otherwise a fresh start (a native chat whose
  TUI was closed before its first prompt has no id yet).
- No model, effort, sandbox or approval flags for tasks: the operator's own codex
  configuration applies.
- The first prompt is the card text only, as for claude / omp (the deep-analysis wrapper
  stays the one exception).

### D4. Hooks and trust

- Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `Stop`, `Interrupt`.
- One command for all of them, the claude pattern:
  `curl -sS -m 3 -o /dev/null -H "Authorization: Bearer $KERMANYCH_NATIVE_TOKEN" -H
  'Content-Type: application/json' --data-binary @- "$KERMANYCH_NATIVE_URL/codex" || true`
  — no stdout, exit 0 always. The raw hook JSON goes to `POST /api/native/:id/codex`
  (`@Public`, bearer-checked, like `/claude`).
- `native-hooks.ts` builds the `-c` arguments and the `hooks.state` table; the hash follows
  codex's algorithm (above) and is pinned by a unit test against a value codex itself wrote.
  If a future codex changes the algorithm, the «Hooks need review» modal shows in the
  session's terminal — visible, not silent.
- Rejected: `--dangerously-bypass-hook-trust` (runs the operator's and the repository's
  untrusted hooks too); answering the modal (writes into `~/.codex/config.toml`).

### D5. Folder trust

The inline `projects` override with the realpath of the cwd on every start and resume, for
agents and chats. The effect is the same as answering «Yes» (the repository's `.codex/`
layer loads), without the write. Rejected: worktree-only (a chat would ask once and write);
never (a dialog on every task and a growing list of dead worktrees in the operator's
config). claude's own trust dialog is unchanged.

### D6. Status mapping

| codex hook | status |
|---|---|
| (launch with a prompt) | `queued` |
| (launch without a prompt) | `done` |
| `UserPromptSubmit` | `thinking` |
| `PreToolUse` | `tool` + `currentTool` = `tool_name` |
| `PreToolUse` `request_user_input` | `waiting_input` |
| `PostToolUse` | `thinking` |
| `PermissionRequest` | `waiting_input` |
| `Stop` | `done` / `in_review` (managed rule) |
| `Interrupt` | `done` / `in_review` |
| pty exit | `stopped` |

- `request_user_input` is codex's ask-the-operator tool [INFERENCE: not observed]; checked in
  the smoke.
- Accepted gaps: codex < 0.163 sends no `Interrupt`, so after Esc the status stays busy
  until the next prompt; a turn that fails has no hook — if codex still sends `Stop` it ends
  `done`, otherwise it stays busy until the next prompt. Rejected: tailing the rollout for
  `turn_aborted` / `error` (a new watch mechanism for one harness).

### D7. Handles, after-turn reads, history

- Every hook writes back a changed `session_id` → `ompSessionId` and `transcript_path` →
  `ompSessionFile` (the columns managed and native claude / omp already reuse). Resume uses
  the id.
- After `Stop` / `Interrupt` (300 ms late, as for claude) the rollout file gives:
  - **usage** — the last non-null `token_count.info.total_token_usage`, absolute
    (`RegistryService.setUsage`): `input = input_tokens − cached_input_tokens`,
    `cacheRead = cached_input_tokens`, `cacheWrite = cache_write_input_tokens`,
    `output = output_tokens`, cost `0`;
  - **model** — the last `turn_context.model`;
  - the armed **PR link** and the `transcript_reset`, through the history below.
- **History** → `OmpMessage[]` → `messagesToTranscript`: user = `event_msg`
  `user_message`; assistant = `response_item` assistant `output_text`; tool calls =
  `function_call` / `custom_tool_call` paired by `call_id` with their outputs; reasoning,
  developer and injected user items are skipped.
- `sessionCostKnown` is false for codex (no cost row, as for native claude).

### D8. Native chat

`-s read-only -a never` on every start and resume. Built-ins cannot write; MCP, plugins and
apps stay, as MCP / extension tools do for claude / omp. Difference, documented: reading is
any shell command, not three tools. Rejected: also disabling apps / plugins / browser /
computer use / web search (untested, and stricter than the other harnesses); no codex chat.

### D9. Session MCP

Agents and chats get the session server via `-c mcp_servers.<name>={url,
bearer_token_env_var}`; the bearer stays in the pty env (`MCP_TOKEN_ENV`, already set for
non-claude harnesses), never in argv. Forks never get it (as today).

### D10. git in the worktree

Nothing added. The smoke runs «Закоміти» on a codex task: if the commit goes through
(possibly after an approval in the terminal) the behaviour is documented; if it cannot work
even after approval, `--add-dir <common git dir>` is tried and the result goes back to the
operator before anything is changed.

### D11. UI

- `LaunchMode` adds `codex`; the launcher «Режим» and the «Чат» chip list
  `Керманич` / `omp` / `claude` / `codex`; `nativeRuntimeFor`, `nativeHarnessName`,
  `sessionLaunchMode` map it; a stored chip value the build does not know keeps falling
  back to managed.
- `KHarnessMark` gets a codex mark; the header reads `codex · нативно · …`; the Сесія
  engine-id hint names `codex resume <id>`; the kit gallery shows a codex card.
- i18n uk/en: `agents.native.modeHint` and friends name codex.

## Changes

- `packages/core`: `runtime.ts` (`NATIVE_HARNESSES`, `NativeHarness`, `isNativeHarness`),
  `types.ts` (`Session.runtime`), `task-reports.ts` (report runtime), `index.ts`.
- `packages/cloud`: types follow (`readSessionReport` via core).
- `apps/api`:
  - `native/native-session.service.ts` — per-harness record; codex argv, hook handler,
    usage/history readers, session-file path.
  - `native/native-hooks.ts` — codex hook / trust / projects / MCP arguments and hash.
  - `http/native.controller.ts` — `POST native/:id/codex`.
  - `http/sessions.controller.ts` — `isNativeHarness`.
  - `supervisor/supervisor.service.ts` — `NativeHarness` on native entry points; managed
    paths narrow through the helper.
  - `registry/registry.service.ts` — runtime guard.
- `apps/ui`: `lib/native-session.ts`, `KHarnessMark.vue`, `AgentsPage.vue`, `ChatPage.vue`,
  `KitGalleryPage.vue`, `lib/api.ts`, `stores/orchestrator.ts`, i18n uk/en.
- `kermanych/README.md` — «Native sessions» and «Native chats».

## Verification

- Unit (`apps/api`): codex status table incl. `Interrupt`, `request_user_input`, bearer
  refusal; usage reader (cumulative, cached split, null `info`); history reader (clean user
  prompts, injected items skipped, tool call/output pairing, string and array outputs);
  argv for start / resume / chat / MCP / no-id fallback; `trusted_hash` pinned to a value
  codex wrote. `supervisor.native.spec.ts`: a codex chat's argv. `packages/core`:
  `isNativeHarness`; the task-report spec that used `"codex"` as an unknown runtime moves to
  another value. `apps/ui`: `native-session.spec.ts` for the codex mode.
- Smoke with real `codex-cli 0.163.0` on the preview api's `PATH`, preview UI in the
  browser, a throwaway git repo:
  - a codex task with a prompt: no trust or hook modal; `queued → thinking → tool →
    done`; the row gets the codex id, rollout path, model and usage; Лог is the TUI;
  - a two-line helper pasted while idle arrives as one message; a second one mid-turn gets
    `native_busy`; Esc mid-turn → `done` (`Interrupt`);
  - an approval prompt → `waiting_input`, approved → back to `thinking`;
  - «Зупинити» → `stopped`; «Продовжити» resumes the same conversation; `/new` in the TUI
    then «Продовжити» continues the new one;
  - «Закоміти» on the task (D10);
  - a native codex chat: opens idle, a write attempt fails, the first message names the
    thread;
  - the session browser's tools are listed in codex;
  - `~/.codex/config.toml` checksum is unchanged by all of the above.

## Documentation impact

`kermanych/README.md` «Native sessions» / «Native chats»: codex as a mode, install
(`npm i -g @openai/codex`), its argv, per-launch hooks and trust (nothing written to
`~/.codex`), the read-only chat by sandbox, no cost, the `Interrupt` / error gaps, the git
behaviour found in D10.

## Appendix: cursor facts (for the follow-up task)

Not verified live (installed `cursor-agent` 2025.09.12 lacks hooks, `--trust`, `--mode`,
transcripts; not signed in). From https://cursor.com/docs/cli, https://cursor.com/docs/hooks,
https://cursor.com/docs/reference/plugins and the 2026.10.14-941492e CLI bundle:

- argv: `agent [options] [-- prompt]`, `--resume <chatId>`; hidden `--new-session-id
  <uuidv4>` lets Kermanych mint the id (undocumented); `--trust` skips the workspace-trust
  dialog; `--mode ask|plan`.
- Per-launch hooks through `--plugin-dir <dir>` (a generated plugin with
  `hooks/hooks.json`); user hooks are fixed at `~/.cursor/hooks.json`, project hooks are
  git-visible. Events `beforeSubmitPrompt`, `preToolUse`, `postToolUse`,
  `postToolUseFailure`, `stop{status: completed|aborted|error, input/output/cache tokens}`,
  `afterAgentResponse`, `sessionStart`, `sessionEnd`; payload carries `conversation_id`,
  `model`, `transcript_path`. Empty stdout + exit 0 for observers; never `{}` from
  permission hooks. Cursor also loads Claude Code hooks from `~/.claude/settings.json`.
- No hook for «waiting for approval / question»: needs a heuristic or OSC-notification
  sniffing.
- Transcript `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (`role`,
  `message.content[]`, `turn_ended`); no usage or model there — per-turn tokens from
  `stop`, model from hooks; no cost.
- Read-only chat only soft (`--mode ask`, Shift+Tab escapes) unless the hidden
  `--allowed-tools` is used.
- Prerequisites: `cursor-agent update`, `agent login`.
