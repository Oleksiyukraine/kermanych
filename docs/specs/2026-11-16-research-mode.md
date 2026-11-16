# «Дослідження»: the project chat moves into the avatar's window

- **Branch:** `feature/refactor-chat-into-research-mode`
- **Scope:** `apps/ui` (the avatar window, a research panel and store, removal of the «Чат» page),
  `apps/api` (the research session's tools, system append and promotion), `packages/core`
  (the append text), i18n `uk` / `en`, `kermanych/README.md`. No cloud migration.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-16),
  approved the same day; implemented on this branch (see «Verification»).
- **Replaces in part** `docs/specs/2026-10-06-native-chats.md` (native chats are retired) and
  `docs/specs/2026-11-04-cuk-control-console.md` decision 2 (the accordion gets a third panel,
  the window opens on the last used panel).

## Goal

The «Чат» tab is not used. Global questions go to ЦУК and the «Асистент менеджменту», and a
project chat on its own tab, next to «Агенти», reads as a fourth kind of chat with no clear
purpose. The operator asked to turn it into «Дослідження»: an agent that only inspects code,
answers questions about the projects of the workspace and researches new features. It must not
write code or documentation.

The avatar's window gets it as a third panel:

- **ЦУК** drives Kermanych.
- **Дослідження** answers questions about the code of the workspace's projects and researches
  features.
- **Асистент менеджменту** answers questions about how development is going.

## Context

- **A chat already is a read-only research session.** `kind: "chat"`, created by
  `SupervisorService.createChat` (`apps/api/src/supervisor/supervisor.service.ts:1412-1451`) in
  the project's own checkout: no worktree, no branch, no card. Tools are `CHAT_TOOLS = read,
  grep, glob` (`apps/api/src/supervisor/chat-tools.ts:9,25`) on every spawn and wake
  (`:4646`). MCP tools are not filtered, so a chat reports findings and skill improvements. It
  takes no agent slot (`countsForSlot`, `:714`). It persists in SQLite, wakes after a restart,
  and its transcript shows tool rows.
- **What the page offers** (`apps/ui/src/pages/ChatPage.vue`, 1285 lines): a history rail of the
  project's chats, «+ Новий» (reuses an empty thread), rename, archive ✕, ▶ promote to an agent
  (`promoteChatToAgent`, `:1480-1538`: the same row becomes `kind: "agent"`, forks the omp
  conversation into a worktree with the full toolset, and gets the `promote` instruction),
  ⊕ «В беклог», a text selection → card, «Лог» / «Знахідки» tabs, model and effort, voice
  (Live and dictation), «Режим» (Керманич / omp / claude / codex TUI).
- **The avatar's window** (`apps/ui/src/components/assistant/AssistantLauncher.vue`) holds an
  accordion: ЦУК, expanded on every opening (`stores/assistant-overlay.ts` `show()`), and the
  «Асистент менеджменту» for owners and managers, with notifications on the left and the
  notepad on the right. The ЦУК column is ~580 px wide at a 1280 px window.
- **The Менеджмент assistant already reads every bound repo of the workspace**: it starts in
  the first one and its prompt lists the absolute paths of the rest
  (`apps/api/src/management/management-prompt.ts:50-78`). It runs on `rpc-chat-pool.ts`, which
  keeps no history across restarts, has a 4-minute turn timeout and shows no tool rows.
- **Local projects carry `workspaceId`** (`packages/core/src/types.ts:29`), so the API can list
  a workspace's bound repos without the client.
- `web_search` is an omp tool already granted to scheduled runs without a project
  (`ONE_SHOT_TOOLS`, `apps/api/src/schedules/schedule-prompt.ts:11`).

## Decisions

1. **Research is the existing chat session, renamed in the UI.** `kind` stays `"chat"`; no
   registry or cloud migration. It keeps persistence, tool rows, model and effort, findings and
   promotion. Rejected: building it on the assistant chat pool like ЦУК (no history after a
   restart, a turn timeout, no tool rows, no promotion); renaming `kind` to `research` (API,
   registry and about ten test files for a name the user never sees).
2. **Read-only, no documentation.** Tools become `read, grep, glob, web_search`. Writing docs is
   left to the agents that research leads to (decision 7). Rejected: letting it write docs:
   it runs in the operator's own checkout, nothing can restrict writes to a docs folder, and with
   a worktree and a branch it would be «Нова задача» again.
3. **It lives in the avatar's window as a third panel, «Дослідження», for every role.** Order:
   ЦУК, Дослідження, Асистент менеджменту (owners and managers only, as today). The «Чат» tab,
   its route and `ChatPage.vue` are deleted. «Агенти» and the «Нова задача» menu do not change.
   Rejected: a third item in the «Нова задача» menu with research sessions listed on «Агенти»
   (an earlier proposal in this interview; the operator preferred the window, where the other
   assistants already live and where notifications already go through the avatar).
4. **The window opens on the panel used last**, ЦУК on the first opening after a start.
   Rejected: always ЦУК (⌘K in the middle of a research would fold it every time).
5. **A research spans the workspace.** The session belongs to the project selected when it was
   started and runs in that checkout. A system append lists the other bound projects of the same
   workspace by name and absolute path, so the agent may read them too, and states the rules:
   read-only, may search the web, does not write code or documents, suggests «Нова задача» or
   «Глибокий аналіз» when the answer is work. A project without a workspace gets itself only.
   An unbound project cannot host a research, so the panel asks to bind the folder, as the page
   did.
6. **Panel layout.** The header has the research's name (double-click renames), «Історія ▾»
   (the workspace's researches, newest first, each with its project; ✕ archives one),
   «Новий», «Знахідки N» (switches the body between the log and `SessionFindings`), and the
   actions of decision 7. The body is `KPanel` in `bare` mode with its own composer, which
   brings model, effort, Хелпери, `@` files, images and voice. While the research panel is
   expanded, that composer takes the place of the window's shared one, so the window still shows
   one composer at the bottom. «Новий» reuses an empty research of the selected project, as
   «+ Новий» did.
7. **Actions: ▶ «Нова задача», «Глибокий аналіз», ⊕ «В беклог».** ▶ opens a small popover:
   the project (any bound project of the workspace, the research's own preselected) and two
   buttons, «Нова задача» and «Глибокий аналіз». Both mint a card assigned to me (`deepAnalysis`
   set by the second) and promote the research in place, as ▶ did. For «Глибокий аналіз»,
   `promoteChatToAgent` reads the card (`getTask`, as `createSessionFromTask` does), stamps
   `Session.deepAnalysis`, and sends the deep-analysis wrapper (`deepAnalysisPrompt` plus the
   resolved skill) around a short ask to analyse what was researched, instead of the `promote`
   instruction. When another project is picked, the same write that turns the row into an
   agent moves it to that project. ⊕ files a backlog card from the opening question, as before,
   and a text selection in the log files one from the selection (KPanel offers it on every
   panel, so it stays rather than becoming a dead control).
8. **Notifications go through the avatar.** The mascot «thinks» while a research turn runs and
   wears the unread dot when one finishes while the window is closed, as for the other two
   panels. Research stays out of «Агенти», the agent map and the attention marks, as chats are
   today.
9. **Only «Керманич» (omp).** A terminal does not fit a 580 px column, so the «Режим» choice
   goes. `createNativeChat` and the native chat branches of `NativeSessionService` are removed.
   Native chat rows left in SQLite are archived by a one-off registry migration; managed chat
   rows simply appear in the history of their project's workspace.
10. **The voice pill** of a research opens the window on the research panel with that session,
    instead of routing to the «Чат» tab.
11. **ЦУК does not hand questions to research** in this task (no `research.ask` action). Its
    places list loses «Чат».
12. **Name:** «Дослідження» (en «Research»). Not «Дослідження проєкту»: it covers the workspace.

## Changes

- **core:** the research system append (rules plus the workspace's project list).
- **api:**
  - `chat-tools.ts`: chat tools gain `web_search`; `launchAppendFor` returns the research append
    for `chat`, built from the session's project and the registry's projects of the same
    workspace (`systemAppendOpts` passes them).
  - `promoteChatToAgent(chatId, taskId)`: reads the card; `deepAnalysis` → session flag and the
    deep-analysis opening; a card of another project → `projectId` updated in the promotion
    write; the revert on failure restores the project too.
  - Remove `createNativeChat`, the `native` body of `POST /sessions/chat`, and the native chat
    paths in `native/native-session.service.ts` (`--tools` for chats, first-message naming).
  - Registry migration: archive `kind = 'chat' AND native = 1` rows at every start;
    `retireManagedClaude` converts only agents now, so a legacy managed-claude chat is archived
    directly instead of becoming a native chat first.
- **ui:**
  - `stores/assistant-overlay.ts`: `AssistantPanel` gains `research`; `show()` keeps the last
    panel.
  - `lib/research.ts` (pure: the workspace scope, the list, the home project, the title) and
    `stores/research.ts`: the selected research, the scoped list, the busy signal the mascot
    reads, and `open(id)` for the voice pill.
  - `components/assistant/ResearchAssistant.vue` (header, history, actions, `KPanel` bare with
    its own composer, findings; create / reuse empty / archive / rename / promote / backlog) and
    `ResearchPromote.vue` (the popover); `composables/useAnchoredMenu.ts` places both popovers.
    `AssistantLauncher.vue` gets the third accordion panel; `CukAssistant.vue` loses
    `foldable` (there is always another panel).
  - Delete `pages/ChatPage.vue`, the `chat` route, the `VIEWS` entry, `common.nav.viewChat`,
    the `chat.page.*` keys (the one still used moves to `chat.notCloudTask`), the «Чат» entry
    in `stores/cuk-chat.ts`, the kit gallery sample, and `KPanel`'s chat-only header buttons
    (▶ ⊕ ✕, with their props, events and `kit.panel.*` strings).
  - `layouts/MainLayout.vue`: the voice pill opens the window for a research session.
- **docs:** `kermanych/README.md` — «Native chats» becomes «Дослідження» under the ЦУК section;
  every mention of the «Чат» tab (provider, machine resources, voice, dictation, Синергія's tab
  position, drafts, «Cloud tasks and local sessions») is updated.

## Verification

- **core:** `test/research.spec.ts` (the append with and without sibling projects) and
  `deep-analysis.spec.ts` — pass.
- **api** (`vitest run --maxWorkers=4` on the 23 spec files that touch chats, promotion, native
  sessions, the registry and reviews): pass. New cases in `supervisor.chat.spec.ts` — the
  toolset on create and on wake; the append lists only the bound projects of the same workspace,
  and a project without a workspace gets itself; a deep-analysis card stamps the flag and opens
  with the wrapper, the ask and the skill block; promotion into another project moves the row
  and works in that checkout; a failed launch reverts the project and clears the flag; a card of
  an unbound project is refused with nothing changed. `registry.runtime.spec.ts`: native chat
  rows are archived at start, a second start changes nothing. `supervisor.native.spec.ts`: an
  old native chat row still cannot be promoted. `tsc --noEmit` clean.
- **ui:** `vitest run --maxWorkers=4` — 103 files, 1071 tests pass, including
  `test/research.spec.ts` (workspace scope, list order and filtering, home project fallbacks,
  titles). `vue-tsc --noEmit` clean.
- **Live preview** (web build, seeded API; the demo project's folder linked to this repository
  so omp could run in it):
  - no «Чат» tab; ⌘K shows ЦУК expanded with the «Дослідження» bar above it;
  - expanding «Дослідження» before the folder existed showed «Не вдалося запустити дослідження:
    …» with «Спробувати ще» in the panel; after linking the folder, «Спробувати ще» opened
    `дослідження 1` with its greeting and the bare panel's composer (model, effort, voice,
    Хелпери, `@`);
  - asked to list its tools and create `probe.txt`, the agent named `read`, `grep`, `glob`,
    `web_search` (plus MCP tools), declined to write and pointed at ▶; no file appeared. Asked
    where `RESEARCH_TOOLS` is defined, it ran `grep` (a tool row with «4 збігів / 3 ф») and
    answered with `apps/api/src/supervisor/chat-tools.ts:10`;
  - Esc closed the window and ⌘K reopened it on «Дослідження» (last panel); Esc inside «Історія
    ▾» closed only the menu;
  - «+» created `дослідження 2`; ✕ archived it and the panel fell back to the first research
    («Історія 1»);
  - a question sent and the window closed by the mascot: tooltip «Асистент думає…», then
    «Асистент відповів» with the dot.
- **Not exercised:** ▶ promotion end to end (the preview has no cloud board, so the popover
  correctly showed «Жоден проєкт воркспейсу не привʼязаний… або не у хмарі» and ▶ stayed
  disabled) — covered by the api tests; a workspace with several projects and the Менеджмент
  panel as a third bar (the preview has no workspaces); the Electron build; the light themes.

## Out of scope

- A ЦУК action that delegates a question to research.
- Native harnesses for research.
- Changes to «Агенти», «Нова задача» or the board.

## Documentation impact

`kermanych/README.md` as listed in «Changes»; `docs/specs/2026-10-06-native-chats.md` and
`docs/specs/2026-11-04-cuk-control-console.md` get a note pointing here.
