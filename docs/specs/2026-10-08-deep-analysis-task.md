# «Глибокий аналіз»: a task that is discussed and documented before it is coded

## Goal

The operator asked (session `add-deep-research-task`, 2026-10-08) for a second way to start a
task. «Нова задача» stays exactly as it is. A new «Глибокий аналіз» runs the same agent, but
its opening prompt makes the agent study the code, interview the operator in detail (in the
spirit of the `/grill-me` skill), write the task document, and only then, after explicit
approval, write code. The entry point is a split button in the style of Quasar's
[split button dropdown](https://quasar.dev/vue-components/button-dropdown#example--split): a
click on the main part opens the usual «Нова задача» popup, and the arrow opens a menu with
«Глибокий аналіз». The operator must be able to tell which mode an agent runs in from its card.

## Context

- «Агенти» (`apps/ui/src/pages/AgentsPage.vue`): the board head's `KBtn` «Нова задача» calls
  `openLauncher()`. «В беклог» / «Запустити» in the launcher write a cloud card
  (`board.createTask(taskInsertFromDraft(...))`) and «Запустити» then calls
  `POST /api/sessions/from-task`.
- `SupervisorService.createSessionFromTask` re-reads the card from the cloud, so the card is the
  source of every launch parameter: the board's ▶, a retry from «Задачі» and another machine
  all launch from the card alone. It writes the SQLite `sessions` row and calls `launch()`,
  which sends the card text plus the co-author / doc-maintain directives as the first prompt
  (managed) or passes the card text as the harness's argv prompt (native).
- The launcher's «Режим» (managed / omp / claude) is a launch choice, not a card field.
- Kermanych's default skills (`packages/core/src/skills.ts`) are overridable by name per
  project, workspace or repository, and `SkillsService.assignedForNames` inlines the resolved
  body into a prompt («Доповнити документацію» does this for `task-spec` and the rest).

## Decisions

- **The mode is a card field: `tasks.deep_analysis boolean not null default false`.** A card
  filed with «В беклог» and launched later from «Задачі», from the board's ▶ or by a teammate
  must still run as a deep analysis, and only the card survives that path. Rejected: a
  launch-only flag in the `from-task` body like «Режим» — the mode would be lost on every
  launch that is not the launcher's own «Запустити». Rejected: reusing the unused free-text
  `tasks.kind` — no migration, but its name collides with `Session.kind`, and a free-text
  column needs a vocabulary check a boolean does not.
- **The session records it too: `Session.deepAnalysis` (SQLite `sessions.deep_analysis`),
  stamped from the card at creation and never updated.** The agent card must show the mode
  even when the card is archived, deleted or in a workspace the board has not loaded, so it is
  not derived from `taskId → board.tasks`.
- **The method is a default skill, `deep-analysis`.** `createSessionFromTask`'s `launch()`
  wraps the task in `deepAnalysisPrompt()` (`packages/core/src/deep-analysis.ts`) and appends
  the resolved `deep-analysis` skill, so a project, workspace or repository can rewrite the
  method by overriding the skill by name («ШІ-команда → Навички»). The short prompt alone is a
  complete ask when the skill cannot be resolved (offline, unreadable repository), as with
  «Доповнити документацію». Rejected: a new entry in core's `AGENTS` registry — it would also
  appear in the trigger agent picker, which `runTriggerAgent` cannot run. Rejected: a fixed
  constant — no way for a team to tune the interview.
- **The transcript shows the operator's own task**, as it already does for the directives; the
  model receives the wrapped text. The mode is visible on the card and in the detail header.
- **Native sessions get the deep-analysis prompt too.** It is part of the task the operator
  chose, not Kermanych's instrumentation: the TUI receives the wrapped prompt (with the skill
  inlined) as its first prompt. Nothing else changes for native sessions.
- **The method:** study the code first and never ask what the repository answers; interview one
  question per message, each with options and a recommended answer; write the task document
  (`docs/specs/…` unless the project's documentation policy says otherwise), commit it and ask
  for an explicit go-ahead; implement only after approval. The skill body is deliberately terse:
  all default skill bodies together must stay under the settings pane's assigned-skills byte
  warning (`ASSIGNED_BYTES_WARN`, 8 KiB, pinned by `apps/ui/test/assignments.spec.ts`), and the
  prompt itself already spells out the four steps and the hint to use the harness's question
  tool.
- **UI.** A new kit component `KSplitButton` (main action + ▾ menu with an icon, a label and a
  caption per item). The menu offers both «Нова задача» and «Глибокий аналіз», each with a
  one-line caption, so the difference is stated where the choice is made. The launcher gets a
  «Глибокий аналіз» checkbox (seeded from the menu choice or from the card being edited) so a
  mis-click can be undone and a backlog card can be switched either way; its title reads
  «Глибокий аналіз» for a new deep card. A `KAnalysisMark` (magnifier + «аналіз») marks deep
  cards on «Агенти» (session and backlog cards), in the detail header, and on «Дошка» cards —
  a teammate pressing ▶ there must know what they launch.
- **Out of scope:** the board's own create/edit form gets no deep-analysis control (it edits no
  launch mode today); editing there leaves the flag untouched.

## Changes

- **Cloud:** migration `supabase/migrations/20261008100000_task_deep_analysis.sql`;
  `Task.deepAnalysis` / `TaskInsert.deepAnalysis` / `TaskPatch.deepAnalysis`
  (`packages/cloud/src/types.ts`), mapped in `packages/cloud/src/tasks.ts`.
- **Core:** `Session.deepAnalysis`; `DEEP_ANALYSIS_SKILL`, `deepAnalysisPrompt()`
  (`deep-analysis.ts`); the `deep-analysis` entry in `DEFAULT_SKILLS`.
- **API:** `sessions.deep_analysis` column (registry), stamped by `createSessionFromTask`;
  `launch()` → `openingPrompt()` sends the wrapped prompt to the managed runtime (the transcript
  row stays the raw task) and to a native harness. The preview seed marks one demo agent as a
  deep analysis so a Kermanych-on-Kermanych preview shows the mark.
- **UI:** `KSplitButton`, `KAnalysisMark`, KIcon `plus` / `analysis`; AgentsPage head, launcher
  checkbox and title, card and header marks; `KSessionCard` / `KKanbanCard` `deepAnalysis` prop;
  `LauncherDraft.deepAnalysis`; the board store's optimistic patch; i18n `uk` / `en`; samples in
  the kit gallery (`#/kit`).
- **Docs:** README «Workspaces, projects and tasks» and «Native sessions».

## Verification

- `pnpm --filter @kermanych/core test` — 18 files, 184 passed (incl. `deep-analysis.spec.ts`).
- `pnpm --filter @kermanych/cloud test` — 11 passed, 2 skipped (live-stack RLS suites); the new
  `deepAnalysis` mapping cases (select, map, create, patch) pass.
- `pnpm --filter @kermanych/api test` — 856 passed, 2 failed. Both failures are
  `test/rpc-session.compact.spec.ts`, and they fail identically on the untouched base commit
  (checked in a throwaway worktree of `HEAD`). New cases: deep card → session flag, wrapped
  prompt with the co-author directive, raw transcript row (`sessions.from-task.spec.ts`); native
  argv carries the wrapped prompt (`supervisor.native.spec.ts`); column round-trip
  (`registry.runtime.spec.ts`).
- `pnpm --filter @kermanych/ui test` — 52 files, 574 passed (draft ↔ card mapping of
  `deepAnalysis` in both directions).
- Typecheck: `@kermanych/ui` and `@kermanych/api` report only errors that the base commit has
  too (`test/runtime-messages.spec.ts` TS2352, `src/http/jira.controller.ts` TS2504).
- Smoke: a preview API (`KERMANYCH_PREVIEW=1`, seeded temp DB) and the UI dev server from this
  worktree. On «Агенти» the head shows the split button; ▾ opens the two-item menu (icon, label,
  caption), ↑/↓ move between items, Esc closes it back onto ▾; «Глибокий аналіз» opens the
  launcher titled «Глибокий аналіз» with the checkbox on; clearing it turns the title into «Нова
  задача»; the main half opens the launcher with the checkbox off. The seeded deep agent shows
  the «аналіз» mark on its card and in the detail header; `#/kit` shows the split button, the
  session card and the kanban card with the mark. Not exercised end to end: a real cloud
  launch — the preview has no Supabase project, and the hosted one does not have the column
  until the migration is pushed.

## Documentation impact

`kermanych/README.md`: a «Глибокий аналіз» paragraph under «Workspaces, projects and tasks»
(what it does, where the choice lives, the marks, the skill override, the migration that must
be applied before shipping the client), and the exception in «Native sessions».
