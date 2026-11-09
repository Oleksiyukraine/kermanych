# «Дизайн» merges into «Синергія»: one prototyping page, two handoffs

- **Branch:** `feature/merge-design-into-synergy`
- **Scope:** `packages/core`, `packages/cloud`, `supabase/migrations`, `apps/api`, `apps/ui`,
  i18n `uk` / `en`, `kermanych/README.md`, `kermanych/docs/specs/2026-10-29-design-tab.md`
  (superseded note).
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-09),
  approved the same day; implemented on this branch (see «Verification»).

## Goal

Kermanych has two pages that prototype a screen with an agent watching the live preview:
«Дизайн» (`docs/specs/2026-10-29-design-tab.md`) and «Синергія»
(`docs/specs/2026-11-06-synergy.md`). They share the rail, `KBrowserPane` with ◎, the voice panel
and the auto-started preview; `SynergyPage.vue` was built from `DesignPage.vue`'s parts. Keep one:
«Синергія». The «Дизайн» tab, its session flavour and its card flag go. The one ability «Дизайн»
has and «Синергія» lacks, handing a prototype to somebody else or to later, moves into «Синергія»
as a second handoff, «Задача →», next to «Імплементувати».

## Context

- **Usage on this machine** (`~/.kermanych/kermanych.sqlite`, other machines unseen): one
  «Дизайн» session ever (29.10, the release day, merged); two «Синергія» sessions in two days, both
  taken to «Імплементувати» (one merged, one in review).
- **«Синергія» already rejected «Дизайн»'s core idea.** Its decision 1 rejects the isolated
  `/__design/...` prototype route: editing an existing page would mean copying it. It edits the
  real code; measured 7.4 s per change against 85 s for a regular agent.
- **`docs/design/` lives without the tab.** `docs/design/2026-11-04-cuk-notepad/` and
  `…-cuk-notifications/` were made by ordinary sessions with the `design-spec` skill. The docs
  policy kind `design`, the skills `design-spec` and `implement-from-design`,
  `browser_screenshot`'s `path`, and «Задача з документа» on a design README
  (`lib/doc-task.ts`, `lib/design-screens.ts`, `DocTaskDialog.vue`) serve those sessions.
- **The card already names a base.** `tasks.branch` is the base the agent forks from
  (`packages/cloud/src/types.ts:121`); `launchTask` passes it to `resolveLaunchParams`
  (`supervisor.service.ts:1283-1290`). A card whose base were `synergy/<slug>` would open its PR
  into `synergy/<slug>`, not into the real base.
- **Old clients select `tasks.design` by name** (`TASK_LIST_COLUMNS`, `packages/cloud/src/tasks.ts:16`).
  Dropping the column breaks the board of every teammate on an older Kermanych.
- **The api can photograph the session browser without a model**: `BrowserHost.screenshot`
  (`apps/api/src/browser/browser-host.ts:104`, Electron `session-browser/actions.ts:239`). The
  pages a prototype touched are recorded per checkpoint (`Synergy-Page:` trailer,
  `packages/core/src/synergy.ts:22`); `synergyChronology` drops restored-away steps.
- **The api has the project's `GIT_TOKEN`** (`gitToken`, `supervisor.service.ts:3815`) but no
  `git push` of its own today; agents push with it inline (`agents.ts:253-274`).
- **«Синергія»'s composer already sends images** with a request (`SynergyPage.vue:508-512`).
- **«Задача з документа»** (`components/docs/DocTaskDialog.vue`) has the title, assignee,
  description with dictation, project, and screenshots attached to the card.

## Decisions

1. **«Дизайн» goes; «Синергія» stays as the only prototyping page.**
   - Rejected: delete «Дизайн» with nothing moved (no way to hand a prototype to somebody else or
     to later). Rejected: a full design document in `docs/design/` from «Синергія» through a PR
     (the prototype is real code with `synergy-mock` stubs and cannot be merged apart from the
     document; ordinary sessions with `design-spec` still make such documents).
2. **«Задача →» pushes the branch, files the card, and closes the session.**
   - Kermanych pushes `synergy/<slug>` to origin and files a card that continues that branch.
     Then the session goes as «Відкинути» does: child, preview, worktree and local branch; the
     branch lives on origin.
   - Whoever launches the card, on any machine, continues the same `synergy/<slug>` with the
     «Імплементувати Синергію» instruction; the PR goes into the original base.
   - Rejected: keeping the session on the rail as «передано» with its worktree (two launch paths,
     worktrees pile up). Rejected: a card without the code (the implementer rebuilds from zero
     and loses the `synergy-mock` map).
3. **Screenshots: Kermanych photographs every distinct page of the chronology itself.**
   - No model call. Each distinct page of `synergyChronology` (restored-away steps excluded), at
     most 6, at the pane's current width. The pane visibly walks those pages while it shoots; the
     session is about to close anyway.
   - Rejected: 390 and 1280 for each page (twice the shots, the pane switches width twice).
     Rejected: the current view only. Rejected: no screenshots (a person reading the card on the
     board sees nothing).
4. **The dialog is `DocTaskDialog`'s, prefilled; the project is fixed.**
   - Title: the session name. Description: `synergyBrief` (start page, requests with their pages),
     the text «Імплементувати» uses, editable and dictatable. Assignee: nobody by default;
     the operator may pick a teammate or themselves. Screenshots as thumbnails, each removable.
   - The project is the session's, not selectable: the branch with the code belongs to it.
   - Nothing is pushed, filed or closed before «Створити».
   - Rejected: other workspace projects as a target (a second card mode without a branch).
     Rejected: no dialog (no handoff to a teammate at filing time).
5. **The card names the prototype in a new column `tasks.synergy_branch`.**
   - Additive migration: `synergy_branch text` (null for every other card). Set on insert only.
     `tasks.branch` keeps the original base, so the PR target survives an edited description.
   - Launching a card with `synergy_branch`:
     - always in a worktree, on that branch taken from origin (a local branch of the same name is
       reused), no new branch, no branch-name model call;
     - `baseBranch` = `tasks.branch`, else the project's default branch;
     - prefix `synergy`; omp, never a native runtime;
     - the opening prompt is «Імплементувати Синергію» with `{{branch}}`, `{{base}}` and
       `{{brief}}` = the card's description, plus the usual images.
   - «Посіпака» skips these cards, as it skipped design cards: a prototype is continued with a
     person at hand.
   - An older client ignores the column and launches the card as an ordinary one from the base.
     That degrades, it does not break.
   - Rejected: no migration, with `synergy/` in `tasks.branch` meaning «continue» and the PR target
     parsed from the description (an edit of the description breaks the PR target). Rejected:
     «Посіпака» taking them under «Дозволити автовиконання».
6. **No «Референси» block in «Синергія».** Images and links go with the first request through
   the composer; the README says so. `designReferenceLink` / `designBrief` go.
   - Rejected: the block in «Нова фіча» held until the first request. Rejected: links in the
     session's system prompt.
7. **`tasks.design` stays in the database, unused.** New code neither reads nor writes it, so
   older clients keep working. Dropping it is a later migration once every teammate runs a build
   without it.
8. **Failures leave a consistent state.** The order on «Створити» is push → card → close.
   - Push refused (no origin, auth, a turn running, no checkpoint yet): the dialog shows the
     error; nothing is filed; the session stays.
   - Card insert fails after the push: the dialog shows the error; the session stays; «Створити»
     again pushes (a no-op) and files.
   - Close fails after the card: the card exists; the toast says the session is still open; the
     operator closes it with «Відкинути».

## Changes

### Core (`packages/core`)
- `types.ts`: drop `Session.designDir`, `Task.design`; add `Task.synergyBranch?`.
- `worktree-names.ts`: drop `design` from `BRANCH_PREFIXES` (an unknown stored prefix already falls
  back to `feature`).
- `agents.ts`: drop `DESIGNER` and `design-save` from `AGENTS`; `agents.spec.ts` follows.
- `design.ts`: drop `designDirFor`, `designReferenceLink`, `designBrief`; keep what
  `docs/design/` readers use (`designDirOf`, `designReadmePath`, `DESIGN_SCREENS_DIR`,
  `designScreenshots`).
- `doc-policy.ts`: drop the design-session gate branch and the `design-readme` failure; keep the
  `design` kind, its rules and its policy line.
- `skills.ts`: `design-spec` no longer names a «Дизайнер»; `implement-from-design` unchanged.
- `analytics.ts`: drop the `design` session type.

### Cloud
- Migration `supabase/migrations/20261109…_task_synergy_branch.sql`: `tasks.synergy_branch text`.
- `packages/cloud`: map `synergy_branch` on read and insert; stop selecting and writing `design`;
  the «Посіпака» queries skip `synergy_branch is not null` instead of `design = true`.

### API (`apps/api`)
- `supervisor.service.ts`:
  - `launchTask`: drop the design branch, `designDir` stamping and the «Дизайнер» opening prompt;
    a card with `synergyBranch` launches as decision 5.
  - drop `saveDesign`; the docs gate no longer takes `designDir`.
  - `pushSynergy(id)`: refused while a turn runs or without a checkpoint; `git push -u origin
    <branch>` with the project's `GIT_TOKEN` (ambient credentials without one); returns
    `{branch, base}`.
  - `synergyScreens(id)`: the distinct chronology pages (≤ 6), each loaded in the session browser
    and shot at the current width; base64 PNGs with their page.
- `worktree.service.ts`: push with a token; a worktree on an existing remote branch.
- `sessions.controller.ts`: drop `POST /sessions/:id/design/save`; add
  `POST /sessions/:id/synergy/push`, `GET /sessions/:id/synergy/screens`.
- `registry.service.ts`: stop reading and writing `design_dir`. The SQLite column stays: an old
  row that carries it still counts as `design` in «Аналітика» (the class stays in core's
  `ANALYTICS_SESSION_CLASSES` for those rows), and the claude-code retirement still skips it.
- `browser-mcp.service.ts`: the `path` hint no longer names a design session.
- `preview/seed.ts`: drop the design row.

### UI (`apps/ui`)
- Drop `pages/DesignPage.vue`, `components/design/DesignFolder.vue`, the `design` route and
  `VIEWS` row, `KDesignMark` (map, board card, session card, kit gallery), the design redirect in
  `MainLayout`, ЦУК's place and redirect (`stores/cuk-chat.ts`), `cuk-digest`'s design kind,
  `saveDesign` in the store and `lib/api.ts`, the «Дизайнер» entries in «ШІ-команда»
  (`lib/ai-team.ts`, `lib/settings.ts`, `agent-about.ts`), the `design-readme` label in
  `FinishSheet.vue`, `AgentsPage`'s design filter, `BoardPage`'s `design` exclusions.
- `SynergyPage.vue`: toolbar «Задача →» beside «Імплементувати» (same enablement: no turn running,
  at least one checkpoint). It opens the dialog: screens load as skeletons, then thumbnails.
  «Створити» runs push → `board.createTask({…, synergyBranch, branch: base}, screens)` → delete,
  through `useAsyncAction`.
- New `components/synergy/SynergyTaskDialog.vue` (changed during implementation from «a mode of
  `DocTaskDialog`»): the doc dialog's work is reading a document, its framing, target projects and
  «Глибокий аналіз», none of which applies here, so a mode would be mostly branches. The new dialog
  uses the same kit pieces and labels (title, assignee, description with «Диктувати») plus the
  screenshot strip (`KAttachStrip`, each shot removable) and runs push → card → close.
- `lib/native-session.ts` `defaultLaunchMode(provider, { synergy })`: a synergy card launches with
  omp, as a design card did (`stores/cuk-chat.ts`, `BoardPage`, `AgentsPage`).
- i18n `uk` / `en`: drop `design.*` and `common.nav.viewDesign`; add the handoff strings.

### Docs
- `kermanych/README.md`: drop «Designs («Дизайн»)»; «Prototyping («Синергія»)» gains «Задача →»
  and the composer note on references; «Design» keeps `docs/design/` through `design-spec`.
- `kermanych/docs/specs/2026-10-29-design-tab.md`: a «Superseded by» line pointing here.

## Verification

- **Tests:** core 32 files / 453 tests (new case in `test/synergy.spec.ts`: distinct handoff pages,
  start page first, at most six; `design.spec.ts` deleted with the functions it covered); cloud
  13 files / 204 tests (`synergy_branch` round trip on read and insert, the «Посіпака» predicate
  skips it); api 131 files / 1379 tests (new: `supervisor.synergy.spec.ts` pushes a prototype to a
  real bare origin with the uncommitted remainder checkpointed first, refuses before the first
  checkpoint, and another clone continues the branch with `attachRemoteBranch`, which refuses a
  local branch carrying commits origin lacks; `sessions.from-task.spec.ts` launches a synergy card
  on its branch with `baseBranch` from the card, prefix `synergy`, a worktree even when the card
  says in place, and the «Імплементувати Синергію» prompt, and refuses a branch outside
  `synergy/`; `supervisor.native.spec.ts` refuses such a card natively before the claim); ui
  92 files / 994 tests; `vue-tsc --noEmit` clean.
- **Live preview** (web build, seeded api): the tabs are Агенти, Дошка, Чат, Синергія, Менеджмент,
  ШІ-команда, Аналітика — no «Дизайн». The seeded Синергія session shows «Імплементувати»,
  «Задача →» (disabled with no step) and «Відкинути». The dialog, opened on it, shows the branch,
  the default-base wording, the session name as title, the brief, «не призначено», the
  no-screenshots note (no session browser in the web build) and the close note; «Створити» on a
  project that is not in the cloud stops with the «publish first» line inside the dialog and the
  session stays.
- **Not verified:** the screenshot walk in the desktop session browser, a push through a real
  `GIT_TOKEN` to GitHub, and a card launched on another machine.

## Documentation impact

`kermanych/README.md` as listed above; the design-tab spec marked superseded.
