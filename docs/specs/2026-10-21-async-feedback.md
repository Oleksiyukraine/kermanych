# Async feedback: every wait is visible, nothing pretends to be empty

## Goal

The operator (session «Глибокий аналіз», 2026-10-21): places in Kermanych again look like bugs
or a frozen app, while they are only async operations without a preloader. Analyse the whole
UI and make every wait visible — and stop it from coming back.

This is the third pass. `bc77aa9` (KBtn `loading`) and `cac6027` (launcher and a handful of
actions) fixed spots; nothing shared stopped new screens from repeating the gap.

## Context

An audit of `kermanych/apps/ui/src` (five read-only scouts, every `@click`, `@update:*`,
`@drop`, `onMounted` and `watch` that starts async work) found ≈150 gaps in seven classes:

| Class | What the operator sees | ≈ |
| --- | --- | --- |
| A. Action without busy affordance | the click «did nothing»; a second click runs it again | 55 |
| B. Empty state while loading | «Журнал порожній», «Беклог порожній», «Реєстр порожній», «Сховище порожнє»… before data arrives | 40 |
| C. Previous scope's data after a switch | Jira/Linear/Slack/chat/branches of the workspace or project just left | 8 |
| D. Controlled select/checkbox snaps back until the server answers | the choice looks ignored; some are not even disabled (racing writes) | 10 |
| E. Result arrives only with the socket echo | row/status changes seconds after the HTTP call returned | 15 |
| F. Modal closes before the await, or can be closed mid-operation | «Запустити» → nothing; errors land in a closed modal | 3 |
| G. App start | no window while the backend boots, then a white window | 1 |

Root causes:

- Every handler hand-rolls `busy = true; try { … } finally { busy = false }` (≈60 copies);
  about 40 feed only `:disabled`. `KIconButton`, `KSelect`, `KChipSelect`, `KCheckbox`,
  `KToggle`, `KSplitButton` have no `loading`.
- No «not loaded» state is rendered: `risks.loading`, `releaseNotes.loading`,
  `passwords.loading`, `projects.loading`, `terminal.loaded`, `board.loading`/`loadError` (on
  «Агенти») are set and never read; templates test `!list.length`, so «not loaded» = «empty».
  `AgentsPage` `entries` folds `transcripts[id] === undefined` into `[]`.
- `jira.probe`, `linear.probe`, page-local `probeSlack` and `jira/linear.close()` do not reset
  state on a workspace change.
- `stores/orchestrator.ts` actions are pass-throughs to `api.*`; visible state changes only on
  `session_update` / `session_removed` / `transcript_*`.
- `sendMessage` respawns a reaped child (15 min idle) **before** the user entry is appended
  (`apps/api/src/supervisor/supervisor.service.ts:1546-1568`), while the composer clears at
  once.
- Electron: `startBackend()` completes before `createWindow()`
  (`apps/ui/src-electron/electron-main.ts:121-122`); `index.html` has an empty body; boot
  `supabase` awaits `auth.init()` (2–4 sequential round trips).
- Background traffic that must never drive a global indicator: `useSubscriptionUsage` poll,
  `installReconcile` (board tasks, outbox), `jira.ts`/`linear.ts` sync tickers, footer git
  status poll, Supabase realtime.

## Decisions

1. **Scope: all ≈150 gaps, one PR, phased commits** (primitives first, then one commit per
   area). Rejected: high + medium only, high only — once the primitives exist the low items are
   one-liners, and leaving them is exactly how «знову» happens.
2. **Data loads show skeletons; user-started work also drives a global progress bar.** An
   empty state renders only when the data for the current scope has loaded. Rejected: an inline
   «Завантаження…» line only (operator chose the richer variant).
3. **The progress bar is opt-in through the action primitive.** Only work started through
   `useAsyncAction` / `trackLoad` (clicks, submits, page/tab/scope loads) counts. Background
   work does not, by construction. Rejected: opt-out tagging of background calls — one forgotten
   tag and the bar twitches every few seconds; rejected: a duration/method heuristic — reconcile
   and tickers can be slow too.
4. **Save-on-change controls are optimistic with a pending state.** The control shows the new
   value at once, is disabled with an inline spinner while saving, and rolls back with an error
   toast on failure. Rejected: pessimistic pending (the snap-back stays), optimistic without
   locking (racing writes).
5. **Socket-echo actions keep the entity pending until the echo or a 15 s timeout.** One pending
   flag per entity; the ⋯ menu, header icons and ⌘ shortcuts of a session all check it. The
   triggering control spins. A spawn (⑂ fork, ⚖ review) settles the parent when the child
   appears. The timeout clears silently (the HTTP call already succeeded). Rejected: pending
   only until the HTTP response (the dead pause stays); optimistic removal for destructive
   process/git operations (shows «done» before the server did it).
6. **Modals by duration.** Short operations (cloud write, session creation, delete): the modal
   stays open, is persistent while busy (Esc, backdrop and «Скасувати» blocked), the primary
   KBtn shows `loading`, it closes only on success, the error renders inside. Long operations
   (preview start): the modal closes at once and progress moves to the entity (▶ spins, the
   desktop browser pane shows «Піднімаю превʼю гілки…»). Rejected: always keep the modal (locks
   the screen for minutes); always close (detaches errors from the form).
7. **A scope change clears and shows the skeleton; a refresh within the scope keeps the data.**
   Switching workspace or project resets dependent state immediately; sync, tab re-open and
   reconcile keep current data and show only the bar (if user-started). Stores already keyed
   `byWorkspace` (`risks`, `release-notes`, `passwords`) show their cache for that workspace at
   once. Rejected: dimmed stale data (another team's numbers, «Підключити» on a connected
   board); a per-workspace cache for `jira`/`linear` (a store redesign, not a preloader).
8. **Timings.** Skeleton appears after 150 ms and, once shown, stays at least 300 ms. The bar
   appears after 300 ms (`SLOW_LOAD_MS` on Board) with the same 300 ms minimum. A button spinner
   appears immediately — it answers the click. Before the skeleton appears the content area is
   blank, never an empty state. Rejected: skeleton immediately (local loads flicker); one 300 ms
   delay for everything (the first 300 ms after a click show nothing).
9. **Composer: optimistic pending bubble.** A sent message appears at once in the log, muted,
   marked «надсилаю…»; the real `transcript_*` user entry replaces it. On failure the bubble is
   removed and the text and attachments return to the composer, with a toast. Same for
   «≡ Підсумок». No server change. Rejected: keeping the text in the composer (the log still
   shows nothing while the agent wakes); appending before respawn on the server (changes
   transcript semantics).
10. **Start-up chain.** The window is created right after the port is chosen, in parallel with
    `bootstrap()`, with `backgroundColor` of the last theme and `show: false` until
    `ready-to-show`. `index.html` carries a static splash (mark, spinner, status line) shown at
    first paint; main reports «Запускаю локальний сервіс…» → renderer «Входжу…»; the splash is
    removed when the app mounts. The sidebar shows a skeleton during `projects.load()` and until
    the socket snapshot. The runtime-choice gate waits until the runtime has been read (no flash
    for returning users). Rejected: renderer-only splash (seconds with no window remain); sidebar
    skeleton only.
11. **Prevention: rules plus the easy path.** The primitives make the right thing shorter than a
    hand-rolled flag; README «Design → Async states» states the rules; `#/kit` gets a live
    «Async states» section; `kermanych/AGENTS.md` points coding agents to the rules. Rejected:
    an ESLint rule (new lint infrastructure for one heuristic that misses classes B–E).
12. **Look.** Skeleton: flat `--k-line` blocks, radius 0, shaped like the content (table rows,
    session cards, kanban cards, text lines, avatars), opacity pulse 0.5↔1 over ~1.2 s, static
    under `prefers-reduced-motion`. Bar: 2 px under the top navigation, `--k-accent`,
    indeterminate sweep; under reduced motion full-width with an opacity pulse. Rejected:
    shimmer (a gradient in a gradient-free system); static blocks (read as broken content).
13. **Verification.** Vitest for the new logic; a manual pass of every area in the preview with
    a throttled network, with screenshots; a QA checklist in this document. Rejected: mount tests
    per screen via `@vue/test-utils` (new dependency; they would pin template wiring).

## Contract (primitives)

All under `kermanych/apps/ui/src`.

- **`composables/useDelayedTrue.ts`** gains `minMs` in `DelayedTrueOptions`: once the flag has
  turned true it stays true at least `minMs` after that moment, even if the source drops
  earlier. Existing callers are unaffected (default 0).
- **`stores/activity.ts`** (Pinia): `start(): () => void` returns an idempotent `end`;
  `active` = count > 0; `barVisible` = `useDelayedTrue(active, 300, { minMs: 300 })`;
  `trackLoad<T>(p: Promise<T>): Promise<T>` for foreground loads.
- **`composables/useAsyncAction.ts`**:
  `useAsyncAction(fn, { onError? }) → { run, busy }`. `run` returns `undefined` without calling
  `fn` while `busy` (one guard for button, Enter and ⌘ shortcut paths); wraps the call in
  `activity.start()`; on error calls `onError` (a modal renders it inline) or by default
  `orchestrator.notify(message, 'error')`. `useKeyedAction(fn)` → `{ run(key, …), busyFor(key) }`
  for per-row actions (risk rows, members, vault rows, findings).
- **`stores/pending.ts`** (Pinia): `mark(key, until: () => boolean, timeoutMs = 15000)`,
  `isPending(key)`, `clear(key)`. `until` is watched reactively, so settling is a condition on
  store state (`!store.sessions.has(id)`, `status` terminal, `archived === true`, a child with
  `parentId === id` exists), not on a socket event type — unrelated `session_update`s (usage
  ticks) cannot settle it early. Keys: `session:<id>`, `project:<id>`, `terminal:<id>`,
  `issue:<key>`, `thread:<id>`.
- **`composables/useOptimisticValue.ts`**: `useOptimisticValue(source, save) → { value, pending,
  set }`; `value` is the pending value while saving, else `source()`; failure drops the pending
  value (rollback) and reports through `useAsyncAction`.
- **Not-loaded convention:** store data for a scope is `undefined` until its first load
  completes (as `risks.byWorkspace`, `transcripts` already are); a list renders
  `KSkeleton` while `undefined`, the empty state only for `[]`. Stores without per-scope keys
  expose a `loadedFor` scope id; `orchestrator` gains `snapshotReceived`.
- **`composables/useLoadPhase.ts`**: `useLoadPhase(notLoaded) → 'blank' | 'skeleton' | 'ready'`
  — owns the 150 / 300 ms skeleton timing (`useDelayedTrue` with `minMs`), so the caller keeps
  the content off screen for the whole minimum.
- **Kit:**
  - `KSpinner` — the one busy glyph; `KBtn` and every new `loading` / `pending` state draw it.
  - `KSkeleton` — `variant: 'line' | 'lines' | 'block' | 'avatar' | 'rows' | 'card'`, `rows?`,
    `width?`, `height?`, `label?`; purely visual (timing is `useLoadPhase`).
  - `KProgressBar` — rendered once in `MainLayout`'s header from `activity.barVisible`.
  - `loading` prop on `KIconButton` (glyph → spinner, disabled, `aria-busy`), `KSelect`,
    `KChipSelect`, `KCheckbox`, `KToggle` (also gains `disabled`), `KSplitButton` (forwards to
    the main half). Busy props are typed `?: boolean | undefined` (exactOptionalPropertyTypes).
  - `pending` prop on `KSessionCard`, `KKanbanCard` (dimmed, spinner, actions disabled). Table
    rows use the existing `KTable.rowClass` plus row-level `KIconButton :loading`.
  - `KPanel`: the existing `promoting` / `refreshing` / `filing` / `clearing` become spinners via
    `KIconButton :loading`; new `pending` (session-level: every session action disabled),
    `stopping`, `branching`, `restarting`, `answering`, `summarizing`, `openingEditor`,
    `composerDisabled`, model / effort overrides with `modelLoading` / `effortLoading`, and
    `outgoing` — KPanel renders the «надсилаю…» bubbles after the log slot (both «Агенти» and
    «Чат» feed it) and exposes `restoreDraft(text, images)` for a failed send.
  - `KComposer`: `modelLoading` / `effortLoading`; send stays blocked while attached images are
    still being read (`useImageAttach().reading`).
- **Electron:** `freePort` → `createWindow(apiBase)` → `bootstrap({ port })` in parallel.
  Preload exposes `backendReady(): Promise<void>` (IPC invoke, rejects on boot failure — main
  keeps its `showErrorBox` + quit) and `onBootStatus(cb)`. A new first boot file
  `boot/backend.ts` awaits `backendReady()` (no-op on the web build). Main remembers the last
  theme background (renderer reports it over IPC; stored in `userData`), falls back to
  `nativeTheme`. The splash's status strings follow the locale the i18n boot reads from
  `localStorage`.

## Inventory and treatment

Codes: **ACT** `useAsyncAction` + `loading` on the control (keyboard paths guarded too);
**SKEL** skeleton until loaded, empty state only after; **RESET** clear on scope switch;
**OPT** optimistic pending value (decision 4); **PEND** entity pending until echo (decision 5);
**MODAL** / **LONG** decision 6; **BUBBLE** decision 9. Paths relative to
`kermanych/apps/ui/src`; line numbers from the audit at `a458606`.

### «Агенти» (`pages/AgentsPage.vue` = P, `components/agents/SessionFindings.vue` = F)

| # | Where | Treatment |
| --- | --- | --- |
| AG1 | ▶ preview start `P:189` → `togglePreview` | LONG + PEND: ▶ spins until the preview url is set; desktop pane placeholder «Піднімаю превʼю гілки…» (`previewPlaceholder()` returns `null` on desktop today; the comment at `P:3118` is corrected); second start blocked |
| AG2 | preview config «Запустити» `P:927` | MODAL for `projects.patch`, then AG1 |
| AG3 | select session → transcript `P:2112`, `entries` `P:1601` | SKEL instead of «Журнал порожній»; the resume path sets `refreshingId` |
| AG4 | ⑂ «Відгалузити» menu `P:246` | PEND until the child session exists |
| AG5 | ⚖ «Рев'ю» menu `P:241`, ⌘D | PEND until the child exists |
| AG6 | ✕ delete agent `P:261,268`, ⌘⌫ | PEND until removed |
| AG7 | composer ↑ `onSend` `P:2564` | BUBBLE |
| AG8 | discard branch/review `P:234` | PEND until removed, toast on error |
| AG9 | ■ stop `P:229,256`, ⌘. | PEND until the status is terminal, toast on error |
| AG10 | ≡ «Підсумок» `KPanel:181` | BUBBLE + ACT guard |
| AG11 | stall «Перезапустити» `KPanel:146` | ACT (`restarting`) + PEND |
| AG12 | ↻ reopen `P:204` | KIconButton `loading` + PEND; menu and ⌘ honour it |
| AG13 | ⤓/⤒ archive/unarchive `P:206,209` | KIconButton `loading` + PEND |
| AG14 | ◼ stop preview `P:189` | KIconButton `loading` |
| AG15 | agent-map subagent row `P:1055` | SKEL instead of «порожній або недоступний» |
| AG16 | «Задача →» from a document `P:595` | SKEL in title/description and assignee list while loading |
| AG17 | launcher modal `P:646` during `launchBusy` | MODAL (persistent; fields and «Видалити» disabled) |
| AG18 | composer effort/model chips | OPT (`KChipSelect :loading`) |
| AG19 | «Задачі» backlog `P:126` | SKEL from `board.loading`; `board.loadError` rendered instead of «Беклог порожній» |
| AG20 | QA tab `P:619`, Docs tab `P:609` | SKEL until card / transcript / `finishInfo` are loaded; tab counts hidden until then |
| AG21 | ⧉ open in editor, ⌘E | ACT (toast replaces `.catch(() => {})`) |
| AG22 | board list before the socket snapshot | SKEL via `snapshotReceived` |
| AG23 | decision card answer (KPanel) | ACT (`answering`) until `pendingUiRequest` clears |
| AG24 | «Знахідки» tab `F:157` | SKEL |
| AG25 | launcher «Від» branches `P:821` | `KSelect :loading` + run counter (drop stale replies) |
| AG26 | «Опублікувати» `P:843` | other launcher buttons disabled during publish |
| AG27 | stranded card ✕ `P:121` | PEND |
| AG28 | finding «Відхилити» `F:36` | ACT |
| AG29 | findings dialog Jira probe / issue types / assignees `F:72-99` | `KSelect :loading`; hint «перевіряю Jira…» while the probe is pending |
| AG30 | card images `P:473` | SKEL blocks |

### Shell, start-up, terminal (`layouts/MainLayout.vue` = L)

| # | Where | Treatment |
| --- | --- | --- |
| SH1 | app start | decision 10 |
| SH2 | runtime gate for a returning user `L:1153` | gate waits for the runtime read |
| SH3 | sidebar during `projects.load()` and before the snapshot | SKEL |
| SH4 | «Розпочати» done/total `L:20` | count hidden until both loads land |
| SH5 | footer branch on project switch `L:1450` | read with `fetch=false` first (branch at once), then `fetch=true`; ↻ glyph spins during the fetch |
| SH6 | footer «Pull» `L:251` | ACT |
| SH7 | footer ↻ `L:272` | ACT |
| SH8 | drag project to another workspace `L:63` | PEND on the project row until the patch resolves |
| SH9 | runtime gate «Підтвердити» `L:400` | ACT (toast replaces `console.error`) |
| SH10 | runtime option buttons `L:379,386` | generation guard so «перевіряю» reflects the last pick |
| SH11 | create workspace / project `L:325,357` | KBtn `loading`; one busy per modal |
| SH12 | onboarding «прив'язати теку» `L:418` | ACT on the chosen-folder step |
| SH13 | terminal panel before `terminal.loaded` (`KTerminalPanel:101`) | SKEL; empty text only after the list ack |
| SH14 | «+» / «Новий термінал» `KTerminalPanel:73,103`, toggle `L:249` | ACT + pending tab; no second spawn |
| SH15 | 🗑 kill terminal `KTerminalPanel:80` | PEND until `exit` |
| SH16 | ManagementPage «×» new chat `ManagementPage.vue:110` | ACT (composer locked until the reset returns) |
| SH17 | ManagementPage workspace chip `ManagementPage.vue:28` | SKEL instead of «воркспейс не вибрано» |

### «Чат» (`pages/ChatPage.vue` = C) and «Дошка» (`pages/BoardPage.vue` = B)

| # | Where | Treatment |
| --- | --- | --- |
| CH1 | «+ Новий» `C:34` | ACT |
| CH2 | project switch / first mount `C:753` | RESET: detail SKEL while the new project's chat is ensured |
| CH3 | select thread `C:54` | SKEL instead of «Порожній чат»; composer disabled until loaded; sets `refreshing` |
| CH4 | thread row ✕ `C:55` | PEND |
| CH5 | header ✕ clear `C:125` | KIconButton `loading` |
| CH6 | ▶ promote `C:106` | KIconButton `loading` |
| CH7 | ⊕ «В беклог» `C:111` | KIconButton `loading` |
| CH8 | ■ stop `C:117` | PEND, toast on error |
| CH9 | ⧉ editor `C:121` | ACT |
| CH10 | rename `C:83` | OPT (new name shown pending until the echo) |
| CH11 | composer send / summary / restart / effort / model | as AG7, AG10, AG11, AG18 |
| CH12 | composer «нова задача» `onNewTask` `C:515` | ACT |
| BD1 | editor «Запустити» `B:272`, after `confirmBinding` `B:1041` | MODAL until the session exists, then navigate |
| BD2 | integration tabs / Jira default on workspace switch `B:412-439` | RESET |
| BD3 | task load `B:711` | SKEL columns instead of «—» / 0 under the hint |
| BD4 | assignee avatars / filter before the roster `B:476` | SKEL avatars |

### Settings (`pages/SettingsPage.vue` = S) and AI team panels (`components/settings/*`)

| # | Where | Treatment |
| --- | --- | --- |
| ST1 | delete project modal `S:630` | MODAL |
| ST2 | delete workspace modal `S:641` | MODAL |
| ST3 | «ШІ-провайдер» select `S:510` | OPT; the CLI self-check that follows shows «перевіряю» |
| ST4 | «Мова агента» select `S:524` | OPT |
| ST5 | env variables table `S:332` | SKEL; «Додати змінну» disabled until loaded (no overwritten rows) |
| ST6 | GIT_TOKEN field `S:230` | SKEL / disabled until loaded |
| ST7 | default branch select `S:174` | RESET + `KSelect :loading` |
| ST8 | «Черга статусів у хмару» `S:582` | SKEL instead of «Локальний сервіс не відповів» |
| ST9 | provider plan lines `S:567` | SKEL until the first poll |
| ST10 | «Обрати» local folder `S:158` | ACT |
| ST11 | member ✕ `S:424` | KIconButton `loading` |
| ST12 | member role select `S:415` | OPT |
| ST13 | sign-out modal `S:655` | MODAL |
| ST14 | save bar «Зберегти» `S:612` | KBtn `loading` |
| ST15 | TriggersPanel load `TriggersPanel:26` | SKEL |
| ST16 | trigger «Увімкнено» `TriggersPanel:70` | OPT |
| ST17 | trigger «Видалити» `TriggersPanel:79` | ACT (keyed) + PEND row until reload |
| ST18 | trigger editor «Зберегти» `TriggersPanel:224` | MODAL |
| ST19 | AiAgentsPanel load `AiAgentsPanel:24` | SKEL |
| ST20 | instruction «Зберегти» / «Повернути дефолт» `AiAgentsPanel:81,96` | ACT; «Збережено» only after the reload |
| ST21 | skill sequence ↑/↓/«Прибрати»/«Додати» `AiAgentsPanel:115` | OPT on the list order |
| ST22 | skills «Видалити»/«Увімкнути»/«Вимкнути» `SkillsLibraryPanel:29,38,40` | ACT (keyed) — fixes the double delete |
| ST23 | SkillsLibraryPanel load `:57` | SKEL |
| ST24 | skill «Редагувати» body `:32` | SKEL in the body field |
| ST25 | skill editor «Зберегти» `:90` | MODAL |
| ST26 | `AiInherited` pop-in, `AiProvenance` «невідомо» | SKEL line / avatar |

### Documentation and vault

| # | Where | Treatment |
| --- | --- | --- |
| DC1 | index state on project select `ProjectDocumentationPage:381` | SKEL instead of «Ще не проіндексовано» |
| DC2 | tree folder expand `DocTreeNode:53` | loading row under the folder; collapses with a toast on error |
| DC3 | remove link × `ProjectDocumentationPage:423` | ACT |
| DC4 | link editor Enter-submit `:529` | ACT guard (no duplicate link) |
| DC5 | relative images in preview `:156`, «Посилання» count `:214` | SKEL blocks; count hidden until loaded |
| VT1 | vault load `ManagementStoragePage:44` | SKEL from `passwords.loading` / `byWorkspace` |
| VT2 | manager role before the roster `:134` | SKEL on row actions until the roster loads |
| VT3 | 👁 / ✎ `:114,115,127` | KIconButton `loading` (keyed) |
| VT4 | «Завантажити» file `:198` | ACT |
| VT5 | ✕ / «Запитати доступ» / «Схвалити» / «Відхилити» `:120,138,22,27` | ACT (keyed) |

### Management (`pages/Management*Page.vue`, `components/home/*`, `risk/*`, `releases/*`)

| # | Where | Treatment |
| --- | --- | --- |
| MG1 | risk register load `ManagementRisksPage:93` (stats, top-5, heat map) | SKEL |
| MG2 | `HomeRisksWidget:6` | SKEL |
| MG3 | risk ✓ reviewed `:179` | KIconButton `loading` (keyed) |
| MG4 | risk ✕ delete `:196` | KIconButton `loading` + PEND row |
| MG5 | «Відповідальний» raw UUID `:163`; release note author `ManagementReleasesPage:158` | SKEL avatar/name |
| MG6 | RiskEditor «Історія» `RiskEditor:202` | SKEL |
| MG7 | Capacity on workspace switch `ManagementCapacityPage:424` | RESET |
| MG8 | Capacity probe → loadBoard gap `:117` | SKEL (loading covers probe too) |
| MG9 | Capacity range / preset / date `:25-36`; `HomeCapacityWidget:22` | SKEL on the logged figures while worklogs load |
| MG10 | releases list `ManagementReleasesPage:23` | SKEL |
| MG11 | per-project branch select `:93` | `KSelect :loading`; placeholder «читаю гілки…» instead of «гілок не знайдено» |
| MG12 | `HomeReleasesWidget:6` | SKEL |
| MG13 | «Надіслати в Slack» before `slack.load` `:183` | disabled with `loading` until loaded |
| MG14 | ReleaseSlackModal open `:131` | SKEL; «not loaded» kept distinct from `null` (`:101`) |
| MG15 | ReleaseSlackModal «Відключити» / «Прибрати» `:29,66` | KBtn `loading` |
| MG16 | integration tiles `ManagementIntegrationsPage:28-78` | SKEL + RESET (`tileState` distinguishes undefined) |
| MG17 | Jira «Далі» + Enter `:93,123` | ACT |
| MG18 | Jira settings token state `:475,571` | SKEL |
| MG19 | Linear / Slack token Enter `:194,292` | ACT guard |
| MG20 | Slack channel step `:305` | SKEL instead of «Бота ще не додано…» |
| MG21 | Slack listening dot `:347` | SKEL dot until refreshed |
| MG22 | Home capacity / tasks widgets `HomeCapacityWidget:55`, `HomeTasksWidget:12` | SKEL from `jira.loading` + RESET |

### Jira / Linear (`components/jira/*`, `components/linear/*`, `stores/jira.ts`, `stores/linear.ts`)

| # | Where | Treatment |
| --- | --- | --- |
| JL1 | drag a card to a column `JiraBoardView:59`, `LinearBoardView:50` | PEND on the card (`issue:<key>`); a pending card cannot be dropped again |
| JL2 | first board load `JiraBoardView:77`, `LinearBoardView:67` | SKEL columns; `loading` covers `probe` + `loadBoard` |
| JL3 | workspace switch | RESET (`probe`/`close` clear `integrations`, `activeId`, `columns`, `issues`; Linear `integration`) |
| JL4 | board switcher `JiraBoardView:4` | SKEL (no empty-board flash) |
| JL5 | «Тільки читання» badge before the probe `:30` | hidden until the token state is known |
| JL6 | «Синхронізувати» `:31` | KBtn `loading` |
| JL7 | merge prompt transitions `JiraMergePrompt:2`, `LinearMergePrompt` | SKEL options instead of «не пропонує переходів» |
| JL8 | status-pick option buttons `JiraStatusPickDialog:5`, `LinearStatusPickDialog:5` | picked option spins; Skip/Cancel disabled while applying (removes the double dequeue) |
| JL9 | ticket comments / worklogs / attachments `JiraTicketDialog:81,142`, `LinearTicketDialog:64` | SKEL |
| JL10 | ticket editor lists `JiraTicketDialog:573`, `LinearTicketDialog:311` | SKEL in the selects (no layout shift) |
| JL11 | status button `JiraTicketDialog:225`, `LinearTicketDialog:84` | spinner |
| JL12 | priority / assignee selects `JiraTicketDialog:239,306`, `LinearTicketDialog:96,147` | OPT |
| JL13 | estimate / start / due inputs | spinner beside the field while saving |
| JL14 | attachment download `JiraTicketDialog:45` | ACT (keyed) |
| JL15 | comment / upload / log work / delete worklog / delete issue (Jira and Linear) | KBtn `loading`; «Ні» disabled during delete |
| JL16 | issue editor open `JiraIssueEditor:117`, `LinearIssueEditor:96` | SKEL; Save and description disabled until loaded (no overwritten text, no missing `issueTypeId`) |
| JL17 | issue editor Save | KBtn `loading` |
| JL18 | launch dialog open `JiraLaunchDialog:83`, `LinearLaunchDialog:83` | SKEL; state reset on open; «Запустити» disabled until loaded |
| JL19 | launch dialog «Запустити» `:29` | MODAL |

### Kit (`components/kit/*`)

| # | Where | Treatment |
| --- | --- | --- |
| KT1 | `KDirPicker` up / folder rows `:11-25` | listing replaced by SKEL while loading; «Обрати цю теку» disabled; run counter |
| KT2 | `KFileTree` second click while loading `:27` | ignored while the folder loads (no self re-expand) |
| KT3 | `KBrowserPane` «Відкрити знову» / «Відкрити превʼю» `:185` | ACT until the first state push |
| KT4 | `KBrowserPane` mount `:534` | SKEL instead of «ще немає відкритої сторінки» until `bridge.state` answers |
| KT5 | `KBrowserPane` retry `:178` | ACT |
| KT6 | `KBrowserPane` pause toggle / viewport / page-dialog | OPT |
| KT7 | `KComposer` attach before the image is read | send disabled until attachments are read |
| KT8 | `KTerminalView` before attach replay | SKEL lines |

## Changes

- **Primitives:** `composables/useDelayedTrue.ts` (`minMs`), `composables/useAsyncAction.ts`,
  `composables/useOptimisticValue.ts`, `composables/useLoadPhase.ts`, `stores/activity.ts`,
  `stores/pending.ts`, `lib/outgoing.ts`; `stores/orchestrator.ts` (`snapshotReceived`,
  outgoing bubbles per session).
- **Kit:** new `KSpinner`, `KSkeleton`, `KProgressBar`; `loading` on `KIconButton`, `KSelect`,
  `KChipSelect`, `KCheckbox`, `KToggle`, `KSplitButton`; `pending` on `KSessionCard`,
  `KKanbanCard`; `KPanel` busy props and outgoing bubbles; `#/kit` «Async states» section.
- **Stores:** `jira`, `linear` (reset on scope change, `loading` across probe), `risks`,
  `release-notes`, `passwords`, `projects`, `terminal`, `board`, `auth` (runtime read state for
  the gate), `management-chat` (reset busy).
- **Pages/components:** every item of the inventory.
- **Electron:** `src-electron/electron-main.ts`, `electron-preload.ts`, `index.html` splash,
  `boot/backend.ts`, `quasar.config.ts` boot order.
- **i18n:** `uk` / `en` strings for the splash statuses, «надсилаю…», loading placeholders.

Commits: primitives + kit + tests (one commit), then the area work (one commit — the shared
`uk` / `en` catalogs make per-area commits non-compiling), then docs (README, AGENTS.md, `#/kit`).

## Verification

- `pnpm --filter @kermanych/ui test`, new cases:
  - `useDelayedTrue` `minMs`: stays true for `minMs` after turning on; never turns on when the
    source clears before `delayMs`.
  - `useAsyncAction`: re-entry returns without calling `fn`; `busy` clears after error; default
    error toast vs `onError`; `activity` counts nested and parallel actions and returns to 0.
  - `activity`: bar visible only after 300 ms and for at least 300 ms; never armed by work not
    started through it.
  - `pending`: settles when the condition turns true; settles on timeout; a spawn settles the
    parent when a child with `parentId` appears; unrelated state changes do not settle.
  - `useOptimisticValue`: shows the pending value, rolls back on failure, adopts the source on
    success.
  - `jira` / `linear`: a workspace change clears board state before the probe resolves; a late
    reply for the previous workspace is ignored.
  - outgoing bubble: removed when the real user entry arrives; on failure removed and the text
    returned.
  - `jira` / `linear`, added after review: a probe in flight survives `close()` (closing the
    board view on a workspace switch must not cancel the new workspace's probe); a probe that
    overlaps `open()` does not stop the board load.
- Typecheck `@kermanych/ui`.
- Manual pass in a preview API (`KERMANYCH_PREVIEW=1`, seeded temp DB) behind a throwaway TCP
  proxy that delays every API response and socket frame by 1.5–4 s.

### Results (2026-10-21)

- `pnpm --filter @kermanych/ui test`: 60 files, 662 passed. `vue-tsc --noEmit`: only the
  pre-existing `test/runtime-messages.spec.ts` TS2352 (present on `a458606`).
- A review pass (reviewer agent over the whole diff) found 14 defects: a Jira/Linear probe
  cancelled by `close()` on a workspace switch, `open()` abandoning its feed on an overlapping
  probe, a Slack modal held open through OAuth, skeletons that never cleared after a failed
  load (chat resume, provider plan, terminal list), a skeleton left after a project switch during
  «+ Новий», a reconcile flashing the empty board, an effort/model pick landing on another
  session, an uncapped decision-card lock, out-of-order panel reloads, a doc-tree node reused
  across projects. All fixed; the Jira/Linear ones got spec cases.
- Observed in the slowed preview: the web splash «Входжу…»; the sidebar skeleton, with the
  «Розпочати» count hidden until loaded; the footer branch shown before the remote fetch; a
  selected session's log as a skeleton from ~100 ms until the transcript arrived (5.5 s), the
  composer locked meanwhile, «Журнал порожній» never shown; ⋯ → «Зупинити» dimming and spinning
  the card at once and blocking the header actions, the card held pending until the 15 s echo
  window ran out (the seeded session never reports a stop); a refused fork as a toast with
  the controls released; on «Чат» a project with no threads showing the detail skeleton while
  the chat is created, then the error toast and no stuck skeleton; the `#/kit` «Async states»
  section.
- Not exercised end to end: the cloud-backed screens (Дошка, Менеджмент, Налаштування cloud
  parts, Jira / Linear, vault) — the preview has no Supabase project; their logic is covered by
  typecheck, the store specs and the review. The desktop start-up chain (window before backend,
  `backgroundColor`, the IPC status) — not launched in Electron here, because a dev Electron on
  this machine would share the operator's running Kermanych; checked by reading Quasar's
  boot sequence and by review.

### QA checklist

1. Cold start of the desktop app: a window with the splash appears before the backend is ready;
   the status line changes; no white flash; the sidebar shows a skeleton, then the tree.
2. Sign in as a user who has chosen a runtime: no runtime-choice gate flashes.
3. «Агенти»: select a dormant session → skeleton, then the log (never «Журнал порожній»).
4. ⑂ / ⚖ / ✕ / ■ from the ⋯ menu and via ⌘D / ⌘⌫ / ⌘.: the card shows pending; a second
   press does nothing; pending clears when the new state arrives.
5. Send a message to a session idle > 15 min: the bubble «надсилаю…» appears at once and is
   replaced by the real message; with the API stopped, the text returns to the composer.
6. ▶ preview on desktop: ▶ spins, the pane shows «Піднімаю превʼю гілки…»; a second ▶ does
   nothing.
7. «Дошка» → editor «Запустити»: the modal stays with a spinner until the session exists.
8. Switch workspace on Capacity, Jira board, Integrations, Home: no data of the previous
   workspace is ever visible; skeletons until the new data arrives.
9. Settings → «ШІ-провайдер»: the new value shows at once with a spinner; on failure it returns
   with a toast.
10. Risks, Releases, Vault, Triggers, Skills, Findings: never an empty-state text before data.
11. Skills «Видалити» double-click: one delete, no error. Docs link editor: Enter twice, one link.
12. Any click that takes > 300 ms shows the top bar; idle app with polling: the bar never
    appears.
13. `prefers-reduced-motion`: skeletons and bar static, spinners static.

## Out of scope (reported as findings)

- The docs «Переіндексувати» success message is wiped by `loadIndexState`
  (`ProjectDocumentationPage.vue:76-79,99-100`).
- `PreviewService.start()` is not deduplicated in flight
  (`apps/api/src/preview/preview.service.ts:29-73`); the UI guard (AG1) covers only this UI.
- `ChatPage.ensureChat` drops the call for a new project while the previous one runs
  (`ChatPage.vue:576`); CH2 shows the skeleton, the race itself is the finding.
- Errors swallowed by `void store.*` / `.catch(() => {})` in session handlers — fixed as a side
  effect wherever a handler moves to `useAsyncAction`; the finding records the defect.
- A failed runtime read at sign-in shows the gate to a returning user (`auth.ts:100-104`); SH2
  covers only the flash while the read is in flight.
- A per-workspace cache for `jira` / `linear` (decision 7, rejected here).

## Documentation impact

- `kermanych/README.md` → «Design»: new «Async states» subsection — the primitives, the
  not-loaded convention, the timings, the modal rule, «no `void api.x()` in click handlers».
- `kermanych/AGENTS.md` (new): points coding agents at that subsection for any UI change.
- `kermanych/README.md` → «Desktop app (macOS)»: the start-up splash, its statuses and the
  remembered window background.
- `#/kit` (`pages/KitGalleryPage.vue`): «Async states» section with live samples.
