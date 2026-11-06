# Plan: scheduled tasks

Task document: `docs/specs/2026-11-06-scheduled-tasks.md`.

Status: steps 1–3, 5 and 6 done; step 4 typechecked, its Electron run not exercised (see the
spec's «Verification»).

The work is split by package. Core comes first because api and ui consume its built `dist`; api,
ui and electron are written in parallel against the contract fixed in core.

## Steps

1. **Core contract** — `packages/core/src/schedules.ts` (vocabulary, occurrence math, due rule,
   validators, `describeSchedule`), `cuk-actions.ts` (the six `schedule.*` kinds, the digest
   fields, `cukNeedsConfirm` by task kind), `types.ts` (`Session.schedule`, three `ServerEvent`s),
   `i18n-codes.ts` (the `schedule_*` refusal codes), `index.ts`.
   - Verify: `pnpm --filter @kermanych/core test`, `pnpm --filter @kermanych/core build`.
2. **Api** — registry tables (`schedules`, `schedule_runs`, `schedule_slips`, the session's
   schedule columns); `schedules/schedule.service.ts` (tick, claim, overlap, catch-up, once
   switch-off, re-arm, retention, snooze, tray state); the reminder, project-run and one-shot
   runners; `http/schedules.controller.ts`; `bootstrap({ schedules })`; ЦУК prompt and context caps.
   - Verify: `apps/api` `vitest run` (new `schedules*.spec.ts`), `tsc --noEmit`.
3. **Ui** — `lib/api.ts`, `stores/schedules.ts`; «Центр сповіщень» tabs, slips, the schedule
   detail view; the ЦУК digest, executor with undo, action cards; the «Розклад · <назва>» badge;
   i18n `uk` / `en`.
   - Verify: `apps/ui` `vitest run`, `vue-tsc --noEmit`.
4. **Electron** — `bootstrap({ schedules })`, hide-on-close while a task is enabled, the menu-bar
   `Tray` and its menu, a real quit from ⌘Q / «Завершити».
   - Verify: an Electron build: close with an enabled reminder → the icon stays and the reminder
     fires; with none → the app quits.
5. **Smoke in the live preview** — a reminder from ЦУК two minutes ahead (result line, «Розклад»
   row, slip and toast), an agent task without a project created through its card and run with
   «Запустити зараз», pause and delete from ЦУК.
6. **Docs** — `kermanych/README.md`, the ЦУК section gains «Розклад»; the spec's verification
   section filled in.

## Risks and order

- No cloud migration: everything is local SQLite with additive columns.
- The project-run path touches `supervisor.service.ts` launch and retirement; regressions there
  are caught by the existing `supervisor.*.spec.ts` suites.
- Background mode changes the quit path of the desktop app; it only engages while at least one
  scheduled task is enabled.
