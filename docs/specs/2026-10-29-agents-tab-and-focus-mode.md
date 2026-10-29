# «Агенти» tab, status filter in the agents column, project switcher and focus mode

- **Branch:** `feature/merge-status-filters-into-agents`
- **Scope:** `apps/ui` only — `lib/buckets.ts`, `lib/agentMap.ts`, `lib/agents-board.ts`,
  `lib/attention.ts`, `stores/orchestrator.ts`, `layouts/MainLayout.vue`, `pages/AgentsPage.vue`,
  `pages/SettingsPage.vue`, `components/agents/AgentMap.vue`, kit (new project switcher, a
  `focus` glyph in `KIcon`), `i18n/{uk,en}`, tests under `apps/ui/test`; `kermanych/README.md`.
- **Builds on:** `docs/specs/2026-10-22-agent-map.md` (decision 2, the map's bucket chips).

## Goal

The operator asked to merge the «Активні», «Очікують» and «Помилки» status buckets into one,
«Агенти»: only there do agents actually exist — «Завершені» is the history of finished work and
«Задачі» are cards nobody has launched yet. It is the first step of a wider rework of the shell:

- the status filter leaves the sidebar and sits on the agents column it filters;
- a project switcher in the header, in the spirit of DataGrip / WebStorm;
- a **focus mode** that hides the left sidebar entirely so the work area takes the screen.

All three ship together in this task (interview, question 8).

## Context

- **Buckets.** `lib/buckets.ts` files every non-chat session into one of five buckets:
  `tasks` (backlog), `active` (queued/thinking/tool/waiting_input), `waiting`
  (done/in_review/stopped), `errors` (error/conflict), `completed` (archived or merged). A fork
  (`parentSessionId`) is filed by its parent. Readers: the sidebar tally
  (`MainLayout.vue:1012-1043`), the agent map (`lib/agentMap.ts:11-29, 106-109`),
  `lib/attention.ts:78`.
- **Two copies of the rule.** The Агенти list does not use `bucketOf`: `AgentsPage.vue:1399-1461`
  filters on the session's own status with its own `WAITING_STATUSES` / `ERROR_STATUSES` /
  `ACTIVE_STATUSES`. A fork under a merged/archived parent, or an archived fork under a live
  parent, is therefore counted in one bucket and listed in another — against the rule stated
  in `buckets.ts:2-4`.
- **Ordering.** «Активні» sorts by launch (`byNewestLaunch`, so concurrent agents do not swap
  places on every tool call); the other buckets by last activity (`byNewestSession`).
- **Sidebar.** `MainLayout.vue:4-131`: bucket nav (`KNavItem`, `:6-17`, definitions `:1001-1007`),
  «Розпочати» checklist, the workspace → project tree with attention marks
  (`lib/attention.ts`) and the «Посіпака» icon (`minionProjects`), «+» for workspaces and
  projects, drag to reorder/move, fold state. Width 264 or a 76px rail toggled by «« / »»
  (`:124-128`, `kermanych.sidebar-collapsed`, rail logic `minified` / `railOpen` `:606-753`).
- **Footer** (`MainLayout.vue:249-358`): account + plan windows, file-manager docks ◧ / ◨,
  terminal `>_`, Pull, branch, ↻, project path.
- **Header** (`MainLayout.vue:133-191`): brand mark, «Керманич», hard-coded `v1.1.2` (`:142`, the
  only place the version lives), `KTopNav` (Агенти | Дошка | Чат), ⚙, theme, language.
- **Scope state.** `selectedProjectId` / `selectedWorkspaceId` drive Агенти, Чат, terminal, file
  manager, footer git, Settings, ШІ-команда, Дошка. A workspace-only selection is a real state:
  Агенти lists every project of the workspace grouped by project (`AgentsPage.vue:1508`) and
  «Нова задача» is disabled (`:41`). Persisted in `kermanych.selection` (`orchestrator.ts:35-62`),
  where an unknown `bucket` value is dropped (`:46`).
- **Search** (`AgentsPage.vue:53-63, 3934-3959`): a sticky full-width field with «знайдено N з M»;
  a bucket/scope change clears the query (`:1421-1426`).
- **Column width:** the agents column can be dragged down to 300px (`:3953-3954`), padding
  `--k-sp-4` each side.
- **Map chips:** `parseMapBuckets` (`agentMap.ts:20-29`) keeps only known values and treats `[]`
  as a deliberate «all chips off». The typical stored value is `["active","waiting","errors"]`.
- **Hotkeys in use:** `⌘B`/`Ctrl+B` file manager (`MainLayout.vue:828`, skipped in text fields),
  `Ctrl+\`` terminal (`:891`), `⌘L` / `⌘F` in the browser pane, `⌘Enter` in the launcher.
- **Operator's usage** (interview): switches projects hundreds of times a day — to launch an
  agent, look at a project's agents, open its chat or terminal; ~60% of switches are prompted
  by a mark in the sidebar, ~40% by intent. Does not use the workspace as a working scope, only
  as grouping. Other users, polled, collapse the sidebar to gain room; some use the 76px rail.

## Decisions

1. **Three buckets: `agents`, `completed`, `tasks`.** `bucketOf`: owner archived or merged →
   `completed`; owner `backlog` → `tasks`; everything else → `agents`. `active`, `waiting` and
   `errors` disappear from the type, the store, the sidebar and the map.
   *Rejected:* keeping five buckets.

2. **The filter lives in the agents column, always, and leaves the sidebar** — in both the full
   sidebar and the 76px rail. A tab row «Агенти · Завершені · Задачі» takes the place of the
   search row (same sticky bar under the column header).
   *Rejected:* tabs only in focus mode with the sidebar nav kept otherwise — one state, two
   controls, and the layout would rebuild itself on every mode switch.

3. **Search becomes a magnifier at the end of the tab row.** A click drops the field in a row
   under the tabs. The field stays open while it holds text; empty, it closes on blur. `Esc` or
   a second click on the magnifier clears the query and closes it. «знайдено N з M» shows while
   the field is open. Switching tab or scope still clears the query (existing watch).
   *Rejected:* closing on blur with a highlighted magnifier (a filtered list with no visible
   cause); clearing on close (loses the result the moment a found card is clicked).

4. **Counts on «Агенти» and «Задачі» only.** «Завершені» carries no number: it is the size of
   the archive, not work waiting, and it grows without bound. The counts use the scope rule the
   sidebar uses today (`sessionScopedProjectIds`; «Задачі» adds `myBacklogTasks`). The column's
   300px minimum stays.
   *Rejected:* all three counts with ellipsised labels; a wider minimum column.

5. **The tab is called «Агенти»** (en «Agents»), the same word as the page. Deliberate: the tab
   holds what the page is about.
   *Rejected:* another word («Поточні», «Відкриті», «Живі»; «В роботі» is taken by a Дошка
   column with a narrower meaning); renaming the page.

6. **Order in «Агенти»: agents that need a human first, then the rest, both by launch time.**
   «Needs a human» = own status `waiting_input`, `error` or `conflict`. Inside each group the
   order is `byNewestLaunch`, so concurrent agents keep their slots; a card moves only when it
   enters or leaves the first group. Forks still follow their parent row (`boardRows`). Under a
   workspace scope a project group that holds a needs-human row leads; otherwise groups are
   ordered by their newest launch. «Завершені» and «Задачі» keep their current order.
   *Rejected:* one flat launch-ordered list (with the sidebar «Помилки N» gone, a crashed agent
   in the current project would be marked only by its dot); sub-sections per state (the three
   buckets again, on one screen).

7. **The list filters with `bucketOf`**; the status copies in `AgentsPage.vue:1399-1406, 1454-1459`
   are removed. The tab count and the list it counts can no longer disagree, and a fork sits
   with its parent. Card actions (unarchive vs. the full set) still key off the session's own
   `archived` flag.
   *Rejected:* keeping the own-status filter and moving the count onto it.

8. **Agent map chips become «Агенти / Завершені»**, default «Агенти». `parseMapBuckets` maps the
   old `active` / `waiting` / `errors` to `agents` (deduplicated), so a stored
   `["active","waiting","errors"]` opens the same map as before; `[]` still means all off.
   *Rejected:* the map keeping its four chips on its own rule; no chips at all.

9. **Saved selection migrates:** `kermanych.selection.bucket` `active` / `waiting` / `errors` →
   `agents`; the default is `agents`. Every `setBucket('active')` caller (`AgentsPage.vue:2172,
   3002`, `ChatPage.vue:810`) moves to `agents`.

10. **A project switcher in the header, right after «Керманич», always visible.** The version
    label leaves the header.
    - *Closed:* the workspace marker and the current project's name; a workspace-only selection
      reads «<workspace> · усі проєкти»; nothing selected reads «Вибрати проєкт». Beside it, a
      **static** (no pulse) summary mark of every project **outside the current scope**:
      `sumAttention` + `levelOf` + `flagsError`, the mechanism a folded workspace row uses.
    - *Open:* the sidebar tree as a dropdown — workspaces in the operator's sidebar order, all
      unfolded, the same «Без воркспейсу» / local-only placement. A workspace header is
      clickable and selects the workspace (`selectWorkspace`); a project row selects the
      project. Each project row carries its attention mark and the «Посіпака» icon, as in the
      sidebar. Keyboard: arrows, `Enter`, `Esc`; closes on choice or outside click.
    - *Selection only:* no create, no drag, no fold — those stay in the sidebar.
    *Rejected:* switcher only in focus mode (the header would differ by mode); non-clickable
    workspace headers (focus mode could enter the workspace state but not leave it via the
    switcher); create actions in the dropdown; marks only inside the dropdown (focus mode would
    hide the signal behind most switches); dropping the workspace-only state (a separate
    refactor touching Дошка, docs, settings, the map).

11. **Focus mode hides the left sidebar entirely, animated; the footer stays.** It is a
    shell-level state, so it applies on every route; persisted in `kermanych.focus-mode`. It is
    independent of the width toggle: «« / »» keeps switching 264 ↔ 76 exactly as today, and
    leaving focus mode restores whichever width was set. While in focus mode the «Розпочати»
    checklist, project creation and drag are out of sight; the switcher replaces the tree for
    navigation.
    *Rejected:* hiding the footer as well (account limits, terminal, file manager, Pull and
    branch are needed mid-task); replacing the 76px rail with focus mode (some users rely on
    the rail); one «« button cycling three states.

12. **Focus toggle: an icon button in the header between «Керманич» and the switcher.** A drawn
    `KIcon` glyph `focus` (corner brackets) — not a «panel» glyph, which ◧ / ◨ already mean in
    the footer (file manager). Pressed state while on (`aria-pressed`), tooltip «Режим фокусу
    (Ctrl/⌘ \)». **Hotkey `Ctrl+\` or `⌘\`**, matched on `e.code === 'Backslash'` so the
    Ukrainian layout works, listened for in the capture phase. It fires in text fields too (the
    composer is where a focused operator types; the chord types nothing). Exception: with focus
    inside the integrated terminal, `Ctrl+\` stays with the shell (`SIGQUIT`) on every OS;
    `⌘\` never reaches a shell and works there. Listed in Settings → «Гарячі клавіші».

13. **The 76px rail stays**, without the bucket icons: «Розпочати» and the workspace marks remain.
    `KIcon` glyphs left with no user after the bucket nav goes are deleted.

14. **The version moves to Settings → «Загальне»** as a read-only line; it remains a single
    constant in one place.

15. **Empty states:** «Агенти» uses the existing `agents.empty.none` / `noneScoped`;
    `agents.empty.waiting` and `agents.empty.errors` are deleted, as are the i18n keys of the
    removed buckets (`common.nav.bucketActive/Waiting/Errors`, `agents.bucket.active/waiting/
    errors`, `kit` nav labels) in both locales.

16. **Selection hints point at the switcher.** The blank-state texts that said «виберіть … у
    лівій панелі» (Агенти, «Нова задача»'s hint, Settings, ШІ-команда, Менеджмент) now say «у
    перемикачі вгорі»: the switcher is on screen in both modes, the sidebar is not. Texts about
    CREATING a workspace or project still point at the sidebar, where creation stays.

## Implementation notes

- `lib/buckets.ts`: `Bucket`, `BUCKETS`, `bucketOf`, `readBucket` (retired names → `agents`),
  used by `stores/orchestrator.ts` (saved selection) and `lib/agentMap.ts` (`parseMapBuckets`).
- `lib/agents-board.ts`: `needsHuman`, `agentsOrder` (families ranked by any member that needs
  a human), `byAgentsGroup`.
- `lib/attention.ts`: `attentionOutside` for the switcher's summary mark.
- Kit: `KSubNav` items take an optional `count`; `KAttentionBadge` takes `still` (no pulse);
  new `KProjectSwitcher` (selection only, rows are `KRailItem`); `KIcon` gains `search` and
  `focus`, loses `activity` / `waiting` / `done` / `alert` / `tasks`.
- `MainLayout.vue`: the bucket nav and its tally are gone; the drawer's `model-value` is
  `!focusMode` (`kermanych.focus-mode`); the divider under «Розпочати» shows only with it.

## Out of scope

- Creating, moving or reordering workspaces/projects from the switcher.
- Removing the workspace-only scope.
- Дошка columns and statuses (`BoardPage.vue`) — unchanged.
- The old sidebar shortcut «click a bucket on another page → jump to Агенти» goes with the
  sidebar nav; the top nav «Агенти» is the way there.

## Verification

- **Unit (`apps/ui/test`, vitest, `--maxWorkers=4`):**
  - `buckets.spec.ts` — three buckets; `done` / `stopped` / `in_review` / `error` / `conflict` /
    live statuses all land in `agents`; fork rules (follows parent; orphan falls back to own).
  - `agent-map.spec.ts` — `parseMapBuckets` maps old values to `agents`, keeps `[]`, defaults.
  - `agents-board.spec.ts` — the needs-human-first ordering: group membership, launch order
    inside groups, no swap on activity, group order under workspace scope.
  - selection migration for `kermanych.selection.bucket` (logic moved to a testable `lib`
    function if it stays inside the store).
  - attention summary of projects outside the current scope.
- `pnpm --filter @kermanych/ui typecheck`.
- **Live check in the running app:** tabs and counts (count = cards listed, including forks
  under a merged parent); search open/close/Esc/blur rules; «Агенти» order with an errored and
  a waiting_input agent; map opens non-empty with the old stored chip value; focus mode by
  button and by `⌘\` (including from the composer), animation, footer still there, width
  restored on exit, survives reload; switcher closed/open states, marks, workspace header
  selection; 76px rail without bucket icons; version under Settings → «Загальне».

## Documentation impact

- `kermanych/README.md`:
  - the sidebar section (`:253-301`): the status filter is no longer in the sidebar; «Задачі»
    count now on the tab; collapsed sidebar paragraph (`:280-285`) without bucket icons;
  - new paragraphs: the «Агенти / Завершені / Задачі» tabs (what each holds, ordering, search),
    the header project switcher, focus mode and its hotkey;
  - «Карта агентів» (`:839-841`): chips «Агенти» / «Завершені»;
  - `:1097`: «Помилки» → the «Агенти» tab.
- `docs/specs/2026-10-22-agent-map.md`: a pointer at decision 2 to this document.
