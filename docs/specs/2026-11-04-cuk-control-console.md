# ЦУК: the avatar opens Kermanych's control console

- **Branch:** `feature/redesign-avatar-control-console`
- **Scope:** `apps/ui` (the launcher window, a new ЦУК store and views, the shared composer, the
  notepad skin of «Список дій», settings labels, i18n `uk` / `en`), `apps/api` (a ЦУК chat
  endpoint and service on a chat pool shared with the Менеджмент chat), `packages/core` (the ЦУК
  action set and its parser), `kermanych/README.md`. No cloud migration.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-04),
  approved the same day; implemented on this branch (see «Verification»).

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
   restarts. The state digest lists live sessions (no merged ones), capped, each with project,
   name, status and whether it waits for an answer (`waiting_input`); a few recent archived ones
   follow, so «розархівуй» can name one (see «Defaults»).
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
8. **The notepad looks like a small tear-off pad built from theme tokens.** Page on `--k-surface`
   with faint ruled lines (`--k-line`) the rows sit on, a thin `--k-accent` margin line on the
   left; at the top a glued strip (`--k-surface2`) with a perforation under it; two sheet edges
   showing beneath the page; «ЗАПИСНИЧОК» in mono caps with the workspace name, the UI font, the
   B/I/U · ☑ · 1. toolbar as one thin strip. Works in all four themes. Three bindings were drawn
   and shown as screenshots — rings, a spiral, the glued pad; the operator picked the pad
   (2026-11-04), with the rings as the way back if it does not wear well.
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

- **Naming.** The panel title is «ЦУК · Центр управління Керманича» (`en`: «ЦУК · Kermanych
  Control Center» — the name stays ЦУК in both locales, as «Керманич» stays a name). The mascot's
  tooltip, the «Гарячі клавіші» row, the gesture switch («Жест для виклику ЦУК») and the
  character picker («Персонаж ЦУК») follow the name.
- **A launched agent** gets the project's defaults (model, effort), prefix `feature`, a worktree,
  and the launch mode last chosen in «Нова задача» (managed or native); the card shows the
  project, an editable title (the launcher's own name rule as the placeholder), the task text and
  «Глибокий аналіз». After launch the console stays open and the result line carries «Відкрити
  сесію».
- **Opening a place steps the window aside.** `navigate` and `session.open` close the window,
  because the operator asked to see the place; ⌘K brings the conversation back.
- **Archived sessions travel too.** The digest lists live sessions first (those waiting for an
  answer at the top), then the ten most recent archived ones, so «розархівуй» has something to
  name; merged sessions and project chats are left out.
- **Images only.** ЦУК has no file tools, so its composer takes images and refuses documents with
  a line saying so; the api drops anything else too.
- **The `/` helpers and 📎** stay on the composer for both panels; the plan chip stays.

## Implementation

- **core:** `packages/core/src/cuk-actions.ts` — the ЦУК action union, `validateCukAction`,
  `parseCukReply`, `cukNeedsConfirm`, DTOs `CukChatAsk` / `CukChatReply`, the digest types. The
  fence grammar is shared with the Менеджмент chat through `parseActionBlocks`
  (`management-actions.ts`); the notepad verbs are the Менеджмент `todo.*` with its validator,
  because it is the same list. New rejection codes `cuk_*` (`i18n-codes.ts`).
- **api:**
  - `assistant/rpc-chat-pool.ts` — the child map, per-key turn queue, spawn with start timeout,
    one turn (interactive prompts cancelled, dropped frames reported), drop, reset, idle sweep;
    `ManagementChatService` now runs on it and keeps its own extras (attachments on disk, Jira
    tools, the docs child). `assistant/models.ts` holds `FAST_MODEL` (`claude-sonnet-5`, was
    `DOCS_MODEL`).
  - `cuk/cuk-prompt.ts` (contract once, context block every turn), `cuk/cuk-chat.service.ts`
    (key `cuk:<userId>`, `noTools`, home directory as cwd, 120 s turn timeout),
    `http/cuk.controller.ts` (`POST /cuk/chat`, `POST /cuk/chat/reset`; rebuilds and caps the
    context, keeps image attachments only). `http/chat-input.ts` holds the attachment and
    Action List parsing both controllers share.
- **ui:**
  - `stores/cuk-chat.ts` — the global conversation, the context (`lib/cuk-digest.ts` builds the
    session and board rows), the executor, the cards (`pending` / `running` / `done` /
    `cancelled`; a refused call puts the card back to `pending` with the reason).
  - The launch uses the primitives every other launch path already shares —
    `taskInsertFromDraft`, `board.createTask`, `api.createSessionFromTask` — as ChatPage does; the
    launcher's component-local flow was not extracted, since nothing of it beyond those
    primitives applies here.
  - `components/assistant/AssistantComposer.vue` — the pill extracted from
    `ManagementAssistant.vue` (draft, attachments, Хелпери, plan chip); both assistants use it.
  - `components/assistant/CukAssistant.vue` (the ЦУК panel, its greeting and examples) and
    `CukActionCard.vue`; `ManagementAssistant.vue` gains the folded window mode; the accordion,
    the role rule and the notepad column live in `AssistantLauncher.vue`;
    `stores/assistant-overlay.ts` gains `panel`. The dock no longer answers ⌘K.
  - `components/assistant/CukNotepad.vue` — the binding and header around `HomeTodoWidget.vue`
    in its new `notebook` skin; the widget re-renders a row another view of the same list
    changed.
  - Settings labels, keymap rows, i18n `uk` / `en`.

## Verification

- `packages/core/test/cuk-actions.spec.ts`: irreversible and Менеджмент-only kinds refused as
  unknown; required fields per kind; the notepad obeys the Action List rules; only navigation and
  the notepad skip the card. `apps/api/test/cuk-chat.spec.ts` and `cuk-controller.spec.ts`:
  contract once then follow-ups, `noTools` and `claude-sonnet-5`, a child per user, reset, the
  image-only filter and the context caps. Full suites: core 306, api 1233, ui 865 passed; api
  and ui typecheck clean (the ui's only errors are the unbuilt `@kermanych/api` in
  `src-electron`, as before).
- Live preview (web build), a workspace injected into the stores (the preview is cloudless):
  - ⌘K opens the window at 1200 × 780 within 1280 × 800, ЦУК expanded with its greeting and
    examples, the notepad column on the right; the mascot shows on Менеджмент too;
  - as the owner, the Менеджмент bar sits above ЦУК; clicking it swaps the panels, each keeps its
    own draft, focus follows; as a developer there is no bar and no caret;
  - «Хто чекає на мою відповідь?» was answered by the real model in ~4 s from the digest;
    «Зупини сесію «Рефактор стора» і відкрий налаштування гарячих клавіш» opened Налаштування →
    Гарячі клавіші at once (window closed, result line written) and left a `session.stop` card
    pending;
  - a `session.stop` card run wrote «Сесію «Додати онбординг» зупинено.» with «Відкрити сесію»;
    a refused `session.archive` printed the api's reason and returned to `pending`;
  - two rows typed and ticked in the notepad appeared in the Огляд tile, and an edit made in the
    notepad while the tile was mounted showed in the tile;
  - below 900 px the notepad hides behind 📝 and slides over ЦУК; dark and light themes.
- Not exercised: `agent.start` / `task.create` end to end (the preview has no cloud board); the
  Electron build (⌘K from inside a session browser page is an unchanged path).
- Notepad binding variants for decision 8: `docs/design/2026-11-04-cuk-notepad/`
  (`notepad-c-pad` — shipped, `notepad-a-rings` — the fallback, `notepad-b-spiral`).

## Documentation

`kermanych/README.md` → a new section «ЦУК — the avatar's control console» (what it sees and
does, the confirmation rule, what it refuses, the notepad, the management panel for managers);
«The Менеджмент tab and its assistant» points to it. `docs/specs/2026-11-03-assistant-overlay.md`
says which of its decisions this one replaces.
