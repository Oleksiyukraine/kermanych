# A scheduled run is told what its earlier runs concluded

## Goal

The operator: «Коли я роблю задачу з "Розклад", як контекст для агента передається не результат
роботи агента-розклад, а така сама задача "розклад"». Each run of an agent task gets only the
task's prompt, so «Аналіз конкурентів» («запропонуй одну нову фічу») proposed «Петля після ПР» on
19 Nov and the same feature as «Цикл після PR» on 23 Nov — while the operator was already building
the first one. A run must know what earlier runs of its task already delivered.

## Context

- The opening prompt of a run is `scheduledRunPrompt` (`apps/api/src/schedules/schedule-prompt.ts`):
  the rules, the skills block, the task. Built in `SupervisorService.openingPrompt` for a project
  run and in `ScheduleService.oneShot` for a run without a project.
- Every run starts in a fresh context: a project run is a new session on a new hidden card, a
  one-shot run is a new child (`docs/specs/2026-11-06-scheduled-tasks.md`, decisions 5, 9, 10).
- The run history is in `schedule_runs` (the latest 50 per task); a finished run keeps
  `summary`, the first line of its answer.

## Decisions

1. **The earlier results go into the opening prompt**, as a block «## Earlier runs of this task»
   between the skills and «## The task»: the run's date in the task's zone and its summary, newest
   first, with the instruction to treat them as delivered and offer something new, build on one,
   or say what changed since.
   - Rejected: resuming one long-lived session for the task (its context grows without bound, and
     decision 10 of the scheduled-tasks spec retires each run's worktree).
2. **Summaries only, the latest 10 `done` runs.** The first line of each answer names the result
   («Пропоную фічу «…»: …»), which is what a repeat must be checked against; whole answers of a
   daily task would swamp the prompt. Failed, skipped and running runs have no result and are left
   out.
   - Superseded: `docs/specs/2026-11-23-scheduled-task-run-memory.md` (decision 4) widens the
     window to every kept `done` run (up to 50) and drops `EARLIER_RESULTS_MAX`.
3. **Both kinds of run get it** — a project run and a run without a project — through the one
   builder, `earlierResultsBlock`.

## Changes

- `apps/api/src/schedules/schedule-prompt.ts`: `EARLIER_RESULTS_MAX = 10`,
  `earlierResultsBlock(runs, timeZone)`; `scheduledRunPrompt` takes `earlierBlock`.
- `apps/api/src/supervisor/supervisor.service.ts` (`openingPrompt`) and
  `apps/api/src/schedules/schedule.service.ts` (`oneShot`): pass the task's run history.
- `apps/api/test/schedules.spec.ts`: a project run's next run lists the earlier `done` summary
  and not the failed run.
- Docs: `README.md` («Розклад» → «A scheduled agent only analyses»),
  `docs/specs/2026-11-06-scheduled-tasks.md` («Unattended»).

## Verification

- `npx vitest run test/schedules.spec.ts --maxWorkers=4` in `apps/api`: 23 passed, including the
  new «tells the next run what the earlier runs concluded, and not what failed».
- `npx tsc --noEmit -p tsconfig.json` in `apps/api`: clean.
- Not verified: a live scheduled run against a real model — whether the model actually avoids the
  repeat is up to it; the test proves only what it is told.

## Documentation impact

`README.md` («Розклад» section) and `docs/specs/2026-11-06-scheduled-tasks.md` («Unattended»)
describe the new block in the opening prompt.
