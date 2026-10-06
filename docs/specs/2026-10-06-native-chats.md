# Native chats: `omp` / `claude` TUI on the «Чат» page

## Goal

Native sessions (`docs/specs/2026-10-05-native-sessions.md`) let a task run in the harness's
own TUI. The operator asked for the same choice on the «Чат» page (session
`add-native-harness-to-chat-page`, 2026-10-06): a chat thread can be Kermanych's managed chat
or `omp` / `claude` in their own interface, with Kermanych only hosting the terminal and
observing.

## Context

- «Чат» (`apps/ui/src/pages/ChatPage.vue`) lists the project's `kind: "chat"` sessions and
  shows the selected one through `KPanel` (transcript + composer). «+ Новий» calls
  `POST /sessions/chat` → `SupervisorService.createChat`, which spawns a managed runtime in
  the project folder (no worktree, no branch) with the read-only tool set `CHAT_TOOLS`
  (`read`, `grep`, `glob`), project skills, triggers and the system append.
- A chat's first operator message is stamped as `Session.task` in `deliver`; the thread title,
  «+ Новий»'s blank-thread reuse and «В беклог» read it.
- ▶ promotes a chat in place into an agent by forking its conversation into a new worktree.
- Native sessions already route every lifecycle call by `Session.native`: resume, deliver,
  stop, restart, delete, transcript (`NativeSessionService`). Their cwd is
  `worktreePath || project.localRepoPath`, so a chat (no worktree) runs in the project folder.

## Decisions

- **Mode is chosen per new chat.** The history header gets a «Режим» chip
  (`Керманич` / `omp` / `claude`, the launcher's `LAUNCH_MODES`) next to «+ Новий». The choice
  is remembered on the machine (`localStorage` `kermanych.chat.mode`) — unlike the agents
  launcher (a modal reset on every open), the chat page has no form to reset with, and a choice
  that reverts on every visit would be re-picked each time. It decides what «+ Новий» and the
  automatic first chat of an empty project create; an existing thread keeps the mode it was
  created with. «+ Новий» reuses a blank thread only of the same mode.
- **API:** `POST /sessions/chat` accepts `native?: AgentRuntimeKind` (validated like
  `from-task`). `createChat(projectId, native)` creates the same `kind: "chat"` row with
  `native: true` and `runtime = native`, then `NativeSessionService.start(row, { resume: false })`
  with no prompt — the harness opens idle (`done`) and the operator types the first message
  into it. A harness that cannot start leaves no row (as the managed path).
- **Read-only stays.** A chat runs in the operator's own checkout, not a worktree; the managed
  chat is git-free and read-only by construction, and that is what keeps «just asking» from
  editing the repo. A native chat therefore gets the same tool set as a launch flag:
  `omp launch --tools read,grep,glob …` / `claude --tools Read,Grep,Glob …`, on start and on
  every resume. This is the one addition to «nothing of Kermanych enters the agent's
  context»: it restricts built-in tools and adds no text (MCP / extension tools, including the
  session browser, are unaffected, as for the managed chat). Rejected: the harness's full
  toolset in the main checkout — a chat would silently become an unisolated agent.
  `CHAT_TOOLS` moves to `supervisor/chat-tools.ts`, shared by the supervisor and the adapter;
  `claudeToolName` is exported from `runtime/claude-code-runtime.ts` for the mapping.
- **Thread name from the history.** The first message is typed into the TUI, not sent
  through `deliver`, so after each turn (`readTurn`) a native chat with an empty `task` takes
  the first user message of its history as `task` — the same field the managed path stamps.
- **Opening a native thread does not start its harness.** A managed thread auto-resumes on
  click (an omp child the idle reaper stops later); a native harness is a TUI process with no
  reaper, so a click per thread would leave one running for every thread looked at. The
  detail column shows «Продовжити» instead (as the agents Лог tab does), and the thread's
  history is loaded from the harness's file so «В беклог» has its seed.
- **Archive stops a native chat's harness.** Archived threads disappear from the page, so a
  harness left running there would have no terminal anywhere. Native agents are unchanged:
  their archived rows stay reachable in «Відкладені».
- **Promotion (▶) is not available for a native chat** (`native_unsupported`; hidden in the
  UI). Promotion forks the conversation into a new worktree; native sessions have no fork
  (branch and review are refused for native agents for the same reason), and the claude
  transcript is keyed by the folder it was started in. «В беклог» (⊕) still files a card.
- Unchanged: managed chats, native agents, the management chat.

## Changes

- `apps/api`:
  - `supervisor/chat-tools.ts` — `CHAT_TOOLS`, moved from `supervisor.service.ts`.
  - `runtime/claude-code-runtime.ts` — `claudeToolName` exported.
  - `native/native-session.service.ts` — `--tools` for `kind: "chat"`; `readTurn` stamps a
    chat's `task`.
  - `supervisor/supervisor.service.ts` — `createChat(projectId, native?)`; promotion refused
    for native; `setArchived` async, stops a native chat's harness.
  - `http/sessions.controller.ts` — `POST /sessions/chat` `native`; archive routes await.
- `apps/ui`:
  - `lib/api.ts`, `stores/orchestrator.ts` — `createChat(projectId, native?)`.
  - `pages/ChatPage.vue` — «Режим» chip (`KChipSelect`, `LAUNCH_MODES`, remembered in
    `localStorage`); the history header wraps so the chip + «+ Новий» drop under the title at
    the rail's minimum width; harness mark on thread cards; native thread → the harness's
    `KTerminalView` (or «Продовжити»), native label in the bar, ■ while the harness runs, ▶
    and the log density switch hidden.
  - i18n uk/en — `chat.page.modeTitle`.
- `kermanych/README.md` — «Native sessions»: native chats.

## Verification

- `apps/api`: `tsc --noEmit` clean; `vitest run` — 847 pass, 2 fail in
  `rpc-session.compact.spec.ts` (the pre-existing failures noted in the native-sessions spec).
  New cases: `supervisor.native.spec.ts` «a native chat» (argv with `--tools` for both
  harnesses and no managed runtime; spawn failure leaves no row; promotion refused with
  `native_unsupported`; archive stops a native chat's harness but not a native agent's) and
  `native-session.spec.ts` (a chat's `task` taken once from the history's first user
  message; an agent's never).
- `apps/ui`: `vitest run` 544 pass; `vue-tsc` — only the pre-existing
  `test/runtime-messages.spec.ts` TS2352 and `src-electron` TS2307 (no api build output).
- End-to-end smoke: built api in preview mode (`KERMANYCH_PREVIEW=1`, isolated DB, seeded),
  project bound to a throwaway git repo, the dev UI in the session browser pane, real
  claude 2.1.285 and omp 18.6.1:
  - `POST /sessions/chat` with `native: "bogus"` → `400 unknown native harness`.
  - Mode `claude` → «+ Новий» opened `чат 2` with claude's TUI (trust dialog, answered in
    the embedded terminal); bar `claude · нативно · готово`, ■ shown, ▶ hidden, claude mark
    on the card. Asked to list its tools and create `x.txt`: it reported only
    Read/Glob/Grep (+ MCP) and no file appeared. The thread renamed itself to the prompt;
    the card showed `116k ток` and no cost.
  - Mode `omp` → `чат 3`, omp's TUI: reported `read, grep, glob`, no `y.txt`; usage with
    cost `$0.04`, `ompSessionFile` recorded.
  - ■ on the omp chat → `зупинено`; switching threads away and back did not restart it
    (placeholder «Продовжити»); «Продовжити» resumed the same conversation
    (`omp launch --resume <file> --tools read,grep,glob …`).
  - ✕ on the running claude chat → its `claude --session-id … --tools Read,Grep,Glob`
    process exited, row `stopped`, archived, gone from the rail.
  - `POST /sessions/:id/promote` on the native omp chat → `{code: native_unsupported}`.
  - Reload: the chip came back as `omp`, the running omp chat's terminal re-attached.
  - Stopping the api left no harness process for the repo and wrote `stopped` on the row.

## Documentation impact

`kermanych/README.md` «Native sessions» — how to open a native chat, that it runs read-only
in the project folder, that opening a thread does not start it, that archive stops it and
that ▶ is unavailable.
