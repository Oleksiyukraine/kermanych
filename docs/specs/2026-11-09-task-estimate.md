# Оцінка в картці і «Оцінка vs факт» в «Аналітиці»

- **Date:** 2026-11-09
- **Branch:** `feature/self-assessment-by-table`
- **Scope:** `supabase/migrations` (one additive column), `packages/cloud` (task mapping),
  `packages/core` (`analyticsReport`), `apps/api` (a local column stamped at launch; Jira and
  Plane launches carry the tracker's estimate), `apps/ui` (the field in «Нова задача» and in the
  board's editor, the «Оцінка vs факт» block, i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-09 («Давай все таки додамо поле… у майбутньому
  дасть нам додаткову статистику»), after `docs/specs/2026-11-08-analytics-time-to-pr.md`
  (decision 6) found no data for the comparison.

## Goal

«Аналітика» should show how a task's time to PR compares with the estimate a person gave it.
Kermanych's own cards carry no estimate. On the operator's machine 461 of 462 agent sessions
come from those cards, so the comparison has nothing to compare. This change adds the
estimate to the card, so the figure accumulates from now on.

## Context

- **Cards.** `public.tasks` is the shared card. Every launch reads it: ▶ in «Агенти» or on the
  board, «Посіпака», the scheduler (`SupervisorService.launchTask`). Card fields are written in
  two forms. «Нова задача» in «Агенти» (`AgentsPage.vue`, via `lib/tasks-view.ts`
  `taskInsertFromDraft` / `taskPatchFromDraft`) and the board's editor (`BoardPage.vue`
  `submitEditor`). The nearest precedent is `tasks.branch_slug`
  (`20261104110000_task_branch_slug.sql`): an additive nullable column on the card, selected on
  every task read.
- **Trackers.** A Jira / Plane / Linear launch mints a shadow card (`createTask`) and launches it
  through the same path. Jira sends `timetracking.originalEstimateSeconds` on the issue the
  launch already reads. Plane has a time estimate only in a project whose estimate type is
  `time` (`plane-map.ts` `mapIssue` → `originalEstimateSeconds`). Linear estimates are points.
- **Analytics is local** (`docs/specs/2026-11-07-developer-analytics.md`, decision 1): it reads
  the local SQLite only, never the cloud.

## Decisions

1. **The card gets `tasks.estimate_minutes`**: a nullable integer, `> 0`. NULL means «не
   оцінено». It is additive, with no backfill and no `tasks_guard()` change. The estimate is not
   *what the card asks for*, so a colleague who sets it does not switch the author's auto-run
   off.
2. **The form field is «Оцінка, год»**, optional, in hours. `1,5` and `1.5` both read as 90
   minutes. Anything that is not a positive number is refused in the form, with the reason, and
   the save waits. Blank clears the column. It sits in both forms: «Нова задача» (beside
   «Гілка») and the board editor (beside «Базова гілка»).
   - Rejected: Jira's duration spelling («2h 30m»). A second notation for one number, and
     hours are what a person estimates in.
   - Rejected: a required field. Most cards would get a guess typed to pass the form.
3. **The estimate is stamped on the local session at launch** (`sessions.estimate_minutes`),
   from the card as `launchTask` reads it. Analytics stays local, and the estimate it compares
   is the one that stood **before** the agent started. An estimate typed after the PR cannot
   bend the figure.
   - Rejected: reading the card's current estimate from the cloud in «Аналітика» (breaks
     decision 1 of the analytics spec, adds egress, and lets a later edit rewrite history).
4. **Tracker launches carry the tracker's estimate.** A Jira launch sends
   `originalEstimateSeconds`, a Plane launch the mapped time estimate, onto the shadow card, so
   it reaches the session the same way. A points estimate (Linear, or Plane `points` /
   `categories`) is not hours and is left out.
5. **«Оцінка vs факт»: one block in «Аналітика», over the PRs opened in the period** (the same
   PRs, and the same non-negative leads, as «Час до PR»):
   - how many of them had an estimate («5 з 12 PR мали оцінку»);
   - the median estimate and the median time to PR of those PRs;
   - the median of the per-PR ratio `estimate ÷ time to PR`, worded «швидше за оцінку в 3,2
     раза» above 1 and «повільніше за оцінку в 1,3 раза» below 1;
   - a fixed note under it: the time is calendar time from launch to PR, not the hours a
     person spent, and the estimate is the card's at launch;
   - no PR with an estimate → «Жоден PR за цей період не мав оцінки. Її вказують у картці —
     поле «Оцінка, год».
   - Rejected: a sum of «saved hours» (`docs/specs/2026-11-08-analytics-time-to-pr.md`,
     decision 5).

## Changes

- **migration `20261109090000_task_estimate.sql`:** `tasks.estimate_minutes integer check
  (estimate_minutes > 0)`.
- **cloud:** `Task.estimateMinutes?`, `TaskInsert.estimateMinutes?`, `TaskPatch.estimateMinutes?:
  number | null` (null clears); `TASK_LIST_COLUMNS`, `toTask`, `toTaskRow`, `createTask`. Test:
  selected and mapped, absent while NULL; sent on create; a null patch clears.
- **core, `analytics.ts`:** `AnalyticsSessionRow.estimateMinutes?`, `AnalyticsReport.estimate`.
  Test: coverage, medians, the ratio, a PR without an estimate left out of the medians, null
  without any.
- **api:** `registry.service.ts`: `sessions.estimate_minutes` (`ALTER TABLE ADD COLUMN`),
  written by `createSession`, read by `analyticsRows`. `supervisor.service.ts` `launchTask`
  stamps it. `jira.service.ts` / `plane.service.ts` `launch` pass the tracker estimate to
  `createTask`.
- **ui:** `lib/tasks-view.ts`: `LauncherDraft.estimate` (the typed text) and
  `estimateMinutesFromText`, used by both mappers. `AgentsPage.vue` and `BoardPage.vue` get the
  field and its refusal. `AnalyticsPage.vue` gets the block. i18n keys in `uk` / `en`.
- **README:** the migration under «Applying a migration to the team's project», the field where
  the launcher's fields are described, and «Оцінка vs факт» in «Аналітика».

## Verification

Run on 2026-11-09:

- Tests: `@kermanych/cloud` 206 (two new: the column selected and mapped, sent on create, cleared
  by a null patch). `@kermanych/core` 462, `test/analytics.spec.ts` 17 (two new: coverage,
  medians, ratio, an unestimated and a negative PR left out; null without an estimate).
  `@kermanych/api` 1383, the full suite (one new in `sessions.from-task.spec.ts`: the launch
  stamps the card's estimate on the local row, `analyticsRows` reads it, and an unestimated card
  gives none). `@kermanych/ui` 997 (`tasks-view.spec.ts`: parsing `1,5` / `1.5` / blank /
  refusals, the round trip, both mappers). `vue-tsc --noEmit` and api `tsc --noEmit` are clean.
- **Live preview, «Аналітика»** (seeded estimates on three of the four PRs of the 7 days: 10 h
  against 3 h, 2 h against 2 h, 6 h against 4 h). The block read «Швидше за оцінку ×1,5 ·
  Медіана оцінки 6 год · Медіана факту 3 год · 3 з 4 PR за період мали оцінку», which matches
  `GET /api/analytics`.
- **Live preview, «Нова задача»:** «Оцінка, год» sits under «Гілка». «2 год» shows the refusal
  in red as an alert. «1,5» brings back the hint.
- Not verified:
  - a real save to the cloud: the preview has no Supabase, and the migration is not yet pushed
    to the team's project;
  - the board editor's field on screen: it was type-checked only;
  - a real Jira or Plane launch carrying its estimate;
  - the `en` texts on screen.

## Documentation impact

`kermanych/README.md`: the migration note, the card field, «Аналітика».
