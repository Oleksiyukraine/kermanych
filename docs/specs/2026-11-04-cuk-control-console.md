# ЦУК: the avatar opens Kermanych's control console

- **Branch:** `feature/redesign-avatar-control-console`
- **Scope:** `apps/ui` (the launcher overlay, a new ЦУК store and view, the notepad, the task
  launch flow extracted from `AgentsPage.vue`, settings labels, i18n `uk` / `en`),
  `apps/api` (a new ЦУК chat endpoint and service), `packages/core` (the `cuk.*` action set and
  its parser), `kermanych/README.md`. No cloud migration.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-04);
  waiting for the go-ahead.

## Goal

Clicking the avatar (or ⌘K, or the circle gesture) today opens the Менеджмент assistant
(`docs/specs/2026-11-03-assistant-overlay.md`). Developers need none of that. The avatar
should open **ЦУК — «Центр управління Керманича»**: a console that sees the state of Kermanych
and drives it, always expanded, with a notepad on its right for quick notes. The Менеджмент
assistant stays available to managers in the same window, folded.

## Context

- **The overlay** is `components/assistant/AssistantLauncher.vue`: the mascot (fixed, left
  edge), a centred modal `min(760px)` wide, height following its content up to 75vh, kept
  mounted with `v-show`. It renders `components/management/ManagementAssistant.vue`
  (`variant="overlay"`, section `management-home`). Hidden on the Менеджмент tab, where ⌘K
  focuses the page's dock instead (old decision 7). State: `stores/assistant-overlay.ts`
  (`open`, `unread`, `summons`).
- **The Менеджмент chat** is `stores/management-chat.ts` → `POST /management/chat` →
  `apps/api/src/management/management-chat.service.ts`: one runtime child per conversation
  (`management:<workspaceId>`), the user's backend (`runtimeFor()`), read-only file tools, Jira
  over MCP. The model emits ```` ```kermanych-action ```` blocks
  (`packages/core/src/management-actions.ts`), validated in core and executed in the browser
  under the user's JWT by `run()` (`management-chat.ts:524`). Its contract opens with «Ти —
  асистент розділу «Менеджмент»» and every turn carries risks, roster, Jira, capacity, Home.
- **Nothing can control the app from a chat today.** Every control verb already exists as a
  store function: `orchestrator.selectWorkspace/selectProject/selectSession`,
  `sendMessage`, `stopSession`, `resumeSession`, `restartSession`, `archiveSession`,
  `unarchiveSession`, `startPreview`, `stopPreview` (`stores/orchestrator.ts`),
  `board.createTask` (`stores/board.ts:340`), `api.createSessionFromTask`. The «Нова задача»
  launch is component-local in `pages/AgentsPage.vue` (`submitLauncher` `:2999`,
  `taskInsertFromDraft`).
- **No notepad exists.** The nearest thing is «Список дій» on Менеджмент → Огляд
  (`components/home/HomeTodoWidget.vue`, `stores/home-todo.ts`, `lib/home-todo.ts`): rows with a
  checkbox or a number, inline B/I/U, up to 200 rows, localStorage `mgmt-todo:<workspaceId>`,
  already written by the Менеджмент chat's `todo.*` actions.
- **Roles:** owner / manager / developer; `projects.canManageWorkspace` = owner or manager
  (`stores/projects.ts:502`).
- **Theme tokens** (`packages/tokens/src/tokens.css`): four themes change colours and depth
  only; no paper colour or handwriting font exists.

## Decisions

1. **ЦУК is a separate assistant.** Its own conversation, contract and action set, about
   Kermanych itself; no risks, capacity, release notes or Jira in its context. The Менеджмент
   assistant, its store and the dock at the foot of the Менеджмент tab stay as they are.
   Rejected: ЦУК as a superset of the Менеджмент assistant (heavier prompt, slower turns, the
   management context developers do not need); replacing the Менеджмент assistant (managers
   lose it).
2. **The window holds both as an accordion.** Two panels stacked: **ЦУК**, expanded on every
   opening, and **«Асистент менеджменту»**, folded to its title bar. Exactly one is expanded;
   clicking the folded one's title expands it and folds the other. One composer at the bottom
   writes to the expanded panel — its placeholder and helpers follow. Draft and pending
   attachments are kept per panel, so switching swaps them and a half-written management
   question never goes to ЦУК. Each panel keeps its own «×» new chat; a turn in flight in one
   panel keeps running while the other is expanded.
   Rejected: ЦУК alone in the window with the Менеджмент assistant only on its tab; a composer
   per panel (two capsules on screen at once).
3. **ЦУК can see, lead and drive live sessions — nothing irreversible.**
   - *Read:* which agents wait for an answer, which failed, which run; what is on the board.
   - *Navigate:* switch tab, workspace or project; open a session; open a settings section.
   - *Start work:* file a board card («в беклог»), or launch an agent on a task as «Нова
     задача» → «Запустити» does, including «Глибокий аналіз».
   - *Drive sessions:* send a message to an agent; stop, resume, restart; archive, unarchive;
     start or stop the live preview.

   Out of reach: deleting a session, finish, creating a PR, merge, deleting a card. Asked for
   one, ЦУК opens the screen that has the button and says which to press.
   Rejected: read-and-navigate only; including the irreversible verbs.
4. **Confirmation by weight.** Navigation, selection and opening a session or a section run at
   once. Everything that spends the subscription or interferes with an agent — launching an
   agent, filing a card, a message to an agent, stop, restart, resume, archive, unarchive,
   preview — renders as an action card under the answer: what will happen (project, task or
   message text, mode, target session), the text editable on the card, «Виконати» /
   «Скасувати». After «Виконати» the app — not the model — writes the result line into the
   transcript. Cards not acted on stay pending; «Новий чат» discards them.
   Rejected: everything at once (a misread intent starts a paid agent or stops a working one);
   a confirmation for every action (a click for «відкрий налаштування»).
5. **One global conversation.** ЦУК sees every workspace, project and live session on this
   machine; the header's current selection is its default target («запусти агента» means the
   selected project; with none selected it asks). Switching workspace does not end the
   conversation; ЦУК works with nothing selected. The transcript lives in memory until the app
   restarts. The state digest lists live sessions only (no archived or merged ones), capped, each
   with project, name, status and whether it waits for an answer (`waiting_input`).
   Rejected: a conversation per workspace (a partial answer to «що чекає на мене?», the chat
   disappearing on every switch).
6. **The notepad is «Список дій».** The same data as the Огляд tile, shown for the current
   workspace and switching with it; with no workspace selected it shows a «pick a workspace»
   line. ЦУК writes to it too («запиши собі: …»), through note verbs mapped onto the
   `home-todo` store, executed at once (it is the operator's own local list).
   Rejected: a separate global notepad (two near-identical lists); free plain text (no ticking
   things off).
7. **Window: large and fixed.** `min(1200px, 92vw)` × `min(780px, 84vh)`, centred. Left column:
   the accordion and the composer. Right column: the notepad, ~300 px, full height from the
   accordion's top to the composer's foot. An empty ЦУК does not collapse: a greeting and 3–4
   clickable examples («Хто чекає на мою відповідь?», «Запусти агента в цьому проєкті…»,
   «Відкрий налаштування проєкту») fill the transcript area. Below ~900 px of window width the
   notepad hides behind a 📝 button in the window head and slides over ЦУК.
   Rejected: height growing with content (the window jumps with every answer); near-full-screen.
8. **The notepad looks like a small notebook built from theme tokens.** Page on `--k-surface`
   with faint ruled lines (`--k-line`) the rows sit on, a thin `--k-accent` margin line on the
   left, a binding strip with rings at the top, «ЗАПИСНИЧОК» in mono caps with the workspace
   name, the UI font, the B/I/U · ☑ · 1. toolbar as one thin strip under the binding. Works in
   all four themes. 2–3 variants of the binding and ruling are drawn and shown to the operator
   as screenshots before one is finalised.
   Rejected: a plain tile look; realistic cream paper with a handwriting font.
9. **The «Асистент менеджменту» panel is for owners and managers of the current workspace.**
   A developer gets the window with ЦУК only, no accordion. With no workspace selected there
   is no management panel. The Менеджмент tab and its dock stay open to every role, as today —
   a separate decision outside this task. Display only; RLS still guards the data.
   Rejected: every role; a barely visible folded icon for everyone.
10. **The window is the same on every tab.** The mascot shows on the Менеджмент tab too; the
    mascot, ⌘K and the circle always open the window with ЦУК expanded (old decision 7 is
    dropped). The Менеджмент tab's dock stays on the page under the blurred backdrop; the
    window's management panel and the dock show the same conversation. The mascot «thinks»
    while either assistant has a turn in flight and wears the dot when an answer from either
    lands while the window is closed.
    Rejected: keeping the mascot hidden on Менеджмент; a window without the management panel
    on that tab.
11. **ЦУК runs on its own endpoint, Sonnet 5, no file tools.** `POST /cuk/chat` and
    `POST /cuk/chat/reset`, a service reusing the Менеджмент chat's mechanics (spawn on the
    user's backend, per-key turn queue, timeouts, idle eviction, attachments), model
    `claude-sonnet-5` (the id the docs turns already pin as the fastest here), no `read` /
    `grep` / `glob`, no Jira tools. The browser sends the state digest with every turn; the
    model emits `cuk.*` actions in the same fenced-block format, validated in core, executed in
    the browser (decision 4 decides at once vs card).
    Rejected: the default model (slow for «відкрий налаштування»); read-only file tools (longer
    turns, the console doing the launched agent's job).

## Defaults not raised in the interview

- **Naming.** The panel title is «ЦУК · Центр управління Керманича» (`en`: «KCC · Kermanych
  Control Center»). The mascot's tooltip, the «Гарячі клавіші» row, the gesture switch
  («Жест для виклику ЦУК») and the character picker («Персонаж ЦУК») follow the name.
- **A launched agent** gets the project's defaults (model, effort, branch prefix, worktree), as
  «Нова задача» does with nothing changed; the card shows the project, the task text and the
  mode (звичайна / «Глибокий аналіз»). After launch the console stays open and the result line
  carries «Відкрити сесію».
- **The `/` helpers and 📎** stay on the composer for both panels; the plan chip stays.

## Implementation

- **core:** `packages/core/src/cuk-actions.ts` — the `cuk.*` action union, its validator and
  the reply parser (sharing the fence and block parsing with `management-actions.ts` rather than
  copying it), DTOs `CukChatAsk` / `CukChatReply`, the state-digest types.
- **api:** `apps/api/src/cuk/` — contract prompt, service, controller; the common child
  mechanics factored out of `management-chat.service.ts` instead of duplicated.
- **ui:**
  - `stores/cuk-chat.ts` — the global conversation, the state digest (sessions, board,
    projects, current selection), the executor; action cards with pending / done / cancelled
    state.
  - The «Нова задача» launch extracted from `AgentsPage.vue` into a shared module used by both
    the page and ЦУК, so the two launch paths cannot drift.
  - A view for the ЦУК transcript and its cards; the shared composer extracted from
    `ManagementAssistant.vue` so the dock and the window keep one implementation; the
    accordion in `AssistantLauncher.vue`; `stores/assistant-overlay.ts` gains the expanded
    panel.
  - The notepad component reusing the `home-todo` store and the row editor of
    `HomeTodoWidget.vue` (one editor, two skins).
  - Settings labels, keymap row, i18n `uk` / `en`.

## Verification

- Unit tests for the `cuk.*` validator and parser (unknown kinds and malformed fields
  rejected, irreversible verbs not accepted) and for the at-once vs card split.
- Live preview (web build), dark and light themes:
  - the window opens expanded on Агенти, Дошка, Менеджмент; size and the notepad column as in
    decision 7, the notepad behind 📝 below 900 px;
  - a manager sees the accordion, switching folds one panel and swaps the draft; a developer
    sees ЦУК only;
  - «хто чекає на мою відповідь?» answered from the digest; «відкрий налаштування проєкту»
    navigates at once; «запусти агента…» renders a card, edit then «Виконати» starts the session
    and writes the result line; «Скасувати» does nothing;
  - a note written in the notepad shows on Менеджмент → Огляд and back; «запиши собі: …» lands
    in both;
  - the mascot thinks and wears the dot for either assistant.
- Not exercised unless the Electron build is run: ⌘K forwarded from a session browser page
  (unchanged path).

## Documentation

`kermanych/README.md` → «The Менеджмент tab and its assistant»: the avatar now opens ЦУК, what
it can and cannot do, the confirmation rule, the notepad, the management panel for managers.
`docs/specs/2026-11-03-assistant-overlay.md` decisions 5–7 point here as superseded.
