# Memory between the runs of a scheduled task

## Goal

A scheduled agent task («Розклад») runs in a fresh context every time. Since
`docs/specs/2026-11-23-schedule-earlier-results.md` a run is told the first lines of its task's
latest 10 `done` runs. That is not enough for four reasons:

- a task cannot pick up where it stopped («what is new since last time», a cursor);
- the run does not know what the operator did with a result (taken into work or rejected);
- a project run re-reports the findings earlier runs already filed;
- a daily task forgets everything older than 10 days.

This change gives a run four kinds of memory. The operator picked all four
(«1 + 2 + 3 + 4»).

## Context

- Opening prompt: `scheduledRunPrompt` / `earlierResultsBlock` in
  `apps/api/src/schedules/schedule-prompt.ts`. A project run builds it in
  `SupervisorService.openingPrompt`, a run without a project in `ScheduleService.oneShot`.
- A run's record is `schedule_runs`. The first line of the answer becomes `summary`
  (`schedule.service.ts` `onProjectRunEnd` / `oneShot`). Each task keeps its newest
  `SCHEDULE_RUNS_KEEP = 50` runs.
- A one-shot run's whole answer is the slip's `body` (`schedule_slips`, `SCHEDULE_SLIPS_KEEP = 200`
  across all tasks). A project run's answer stays in its retired session's transcript.
- Findings are stored in `session_findings.session_id`, and a run's session has
  `sessions.schedule_id`. `list_findings` sees only the current session
  (`findings/findings-tools.ts`), so every project run starts with an empty list.
- `schedules.updated_at` changes on any edit, so it cannot tell when the prompt changed.
- Schedules, runs and slips live only in the local SQLite registry. There is no cloud sync and no
  Supabase migration.
- UI: the slip view `ScheduleSlipView.vue` and the task view with its run history
  `ScheduleTaskView.vue`. Current and proposed screens are in
  `docs/design/2026-11-23-scheduled-task-run-memory/screens/`.

## Decisions

1. **Notes are a final section of the answer.** The rules ask the run to end its answer with
   `## Notes for the next run`, which holds whatever the next run needs: a cursor, what was
   checked, what to look at next. Kermanych cuts this section out of the answer and stores it in
   `schedule_runs.notes`. The rest of the answer (`summary`, the slip's `body`) does not contain
   it. The next run gets the notes of the latest `done` run that has them, as the block
   «## Notes from the previous run».
   - The run rewrites the notes in full every time and carries forward what still matters. The
     cap is 4000 characters, and anything longer is cut with a mark.
   - A failed run leaves no notes and does not overwrite the earlier ones.
   - Rejected: a `notes.md` file in `scheduleDir`. A run without a project would need a write
     tool, and a project run would have to write outside its worktree. The size would not be
     controlled and there would be no history.
   - Rejected: an MCP tool `remember`. Only project runs have the `kermanych` MCP server.
2. **The operator reacts to a result with «Взято в роботу» or «Не цікаво».** The reaction is
   stored in `schedule_runs.reaction` (`taken` | `rejected` | NULL) and can be changed or
   removed. In the earlier-results block it becomes a mark next to the line, and the rules say:
   do not repeat a taken result, but you may build on it; do not repeat a rejected one and do
   not build on it. A result with no reaction counts as delivered, as before.
   - Rejected: a free-text comment with the reaction (more UI; can be added later without
     touching the schema).
   - Rejected: «Взято» alone, which would not tell a rejected result from one that is merely
     delivered.
3. **Earlier runs' findings go into the prompt.** A project run gets the block «## Findings
   earlier runs reported»: up to the 50 newest findings from the task's earlier runs, in every
   status. Each line is `[status → Jira KEY / Plane KEY / board card] (kind) title`. The rules:
   do not report them again, and a `dismissed` finding is the operator's decision. A finding
   whose session the operator deleted is gone together with it.
   - Rejected: widening `list_findings`, because it only works if the agent calls it.
   - Rejected: both the prompt block and `list_findings`, because that is two sources of the
     same data.
4. **The earlier-results window is every stored `done` run (up to 50), not 10.** The new column
   `schedules.prompt_changed_at` is set on create and whenever the prompt text changes (not the
   schedule, model or name). Results and notes of runs started before it are not dropped; they
   carry the mark «(before the task was last changed)». Reactions and findings are shown
   regardless of prompt changes. Existing tasks get `prompt_changed_at = created_at`.
   - Rejected: dropping everything from before the change, because a small rewording would wipe
     the memory of earlier results.
   - Rejected: keeping 10 and only adding the mark.
5. **The reaction is set in two places, one record behind both.**
   - In the slip view: a row of toggles under the facts, above the answer (① in
     `slip-proposed@1280.png`).
   - In the task's run history: at the right of the top line of every `done` run (③ in
     `task-proposed@1280.png`).
   - The reaction shows immediately (`useOptimisticValue`). If saving fails, it rolls back and
     says why. A run that is not `done`, or a slip whose task is gone, has no toggles.
   - Rejected: the slip only (the slip drops out after the 200 cap, and an old result could then
     not be re-judged).
   - Rejected: the history only (an extra step after reading the result).
   - Rejected: the slip's footer (no room next to «Відкрити задачу» and «Обговорити в ЦУК»).
6. **The notes are visible and can be cleared.** The task view gets a collapsible block
   «Нотатки для наступного запуску» between «Що робити» and «Історія запусків». It shows the
   notes the next run will get, with their run's date and, if they predate the prompt change,
   the mark. The «Очистити нотатки» button sits next to it, with a confirmation and a saving
   state. It sets `schedules.notes_cleared_at`: notes of runs started before it no longer go into
   the prompt or show in the block, while the runs themselves keep them in history.
   - Rejected: hidden notes (an opaque memory that shapes every run).
   - Rejected: read-only notes without clearing (bad notes could not be fixed).

## Changes

- `packages/core/src/schedules.ts`:
  - `ScheduleRun` gets `notes?` and `reaction?`; `ScheduledTask` gets `promptChangedAt` and
    `notesClearedAt?`; `ScheduleRunReaction = "taken" | "rejected"`.
  - `currentNotesRun(task, runs)`: the one rule for «which notes go to the next run», shared by
    the api and the UI; `beforePromptChange(task, run)` for the mark.
  - `splitRunNotes(answer)` returns `{ answer, notes }`, with `RUN_NOTES_HEADING` and
    `RUN_NOTES_MAX = 4000`. Any heading level and a trailing colon are accepted; the last
    heading wins.
  - `isScheduleRunReaction`; the refusal code `schedule_run_no_result` (`i18n-codes.ts`) for a
    reaction on a run that is not `done`.
- `apps/api/src/registry/registry.service.ts`:
  - New columns `schedule_runs.notes`, `schedule_runs.reaction`, `schedules.prompt_changed_at`
    (backfilled from `created_at`) and `schedules.notes_cleared_at`, added the same way as the
    other `ALTER TABLE … ADD COLUMN` guards.
  - `listScheduleFindings(scheduleId, limit)` (`session_findings` of the sessions with that
    `schedule_id`). The reaction and the clearing go through `updateScheduleRun` / `putSchedule`.
- `apps/api/src/schedules/schedule-prompt.ts`:
  - A rule about the notes section.
  - `earlierResultsBlock` up to `SCHEDULE_RUNS_KEEP` (`EARLIER_RESULTS_MAX` is gone), with
    reaction marks and the «before the task was last changed» mark.
  - `previousNotesBlock`, `earlierFindingsBlock` (`EARLIER_FINDINGS_MAX = 50`) and
    `runMemoryBlock`, which joins the three for both callers.
  - `scheduledRunPrompt` takes `memoryBlock`. The order is: rules, skills, earlier results,
    notes, findings, task.
- `apps/api/src/findings/findings-tools.ts`: `findingLine(f)`, the one line format that
  `list_findings` and the findings block share.
- `apps/api/src/schedules/schedule.service.ts`:
  - `splitRunNotes` on both run ends (`onProjectRunEnd` and `oneShot`): notes go to the run;
    `summary` and the slip's `body` come from the answer without them.
  - `update` sets `promptChangedAt` when the prompt text changes.
  - `react(scheduleId, runId, reaction)` (only a `done` run of that task) and `clearNotes(id)`
    publish `schedule_run_update` / `schedules_update`.
- `apps/api/src/supervisor/supervisor.service.ts` (`openingPrompt`): passes the new blocks.
- `apps/api/src/http/schedules.controller.ts`: `PUT :id/runs/:runId/reaction`
  `{ reaction: "taken" | "rejected" | null }` and `POST :id/notes/clear`.
- `apps/ui/src/lib/api.ts`, `apps/ui/src/stores/schedules.ts`: `reactScheduleRun` /
  `clearScheduleNotes` and the store's `react` / `clearNotes`. The slip view loads the task's
  runs through the same store action the task view uses.
- `apps/ui/src/components/assistant/ScheduleRunReaction.vue`: the two toggles
  (`useOptimisticValue`), used by `ScheduleSlipView.vue` (a «Реакція» row in the facts) and
  `ScheduleTaskView.vue` (each `done` run of an agent task). `ScheduleTaskView.vue` also gets the
  notes block (`<details>`) with «Очистити нотатки» behind `confirmAction`.
- `apps/ui/src/i18n/{uk,en}/index.ts`: the strings.
- Docs: `README.md` («Розклад»), `docs/specs/2026-11-06-scheduled-tasks.md` («Unattended»), and a
  note in `docs/specs/2026-11-23-schedule-earlier-results.md` that decision 2 (10 runs) is
  superseded by decision 4 here.

## Verification

- `apps/api` vitest (`--maxWorkers=4`), `test/schedules.spec.ts`:
  - the notes are cut out of the answer, saved on the run, and absent from `summary` and the
    slip's `body`;
  - the next run gets the notes of the last `done` run, and a failed run does not overwrite
    them;
  - after clearing, the old notes no longer go into the prompt;
  - the reaction marks reach the prompt;
  - results from before the prompt change carry the mark, and a change of the schedule alone
    does not set it;
  - a project run sees the findings of an earlier run of the same task and not those of another
    task.
- `packages/core` vitest: `splitRunNotes` (the last heading, its level and colon, no section, an
  empty section, a mention inside a line, over the cap) and `currentNotesRun`.
- `apps/ui`: no new test. The rollback on a refused reaction is `useOptimisticValue`'s, already
  covered by `test/async-action.spec.ts`. `test/schedules.spec.ts` and
  `test/notification-center.spec.ts` pass with the new task fields.
- `tsc --noEmit` in api and core, `vue-tsc --noEmit` in ui.
- Live preview, a task with seeded runs (`slip-implemented@1280.png`, `task-implemented@1280.png`):
  - «Взято в роботу» set in the slip shows as pressed in the history and is stored on the run.
  - «Не цікаво» in the history and pressing «Взято» again to take it back are stored the same
    way.
  - The notes block opens from its summary. «Очистити нотатки» asks, then sets
    `notes_cleared_at`, and the block goes.
- Not verified unless a model is available in the preview: a real run against a model, i.e.
  whether the model follows the notes and the reactions. The tests prove only what it is told.

## Documentation impact

- `README.md` («Розклад»): what a run is told, the reactions, the notes and their clearing.
- `docs/specs/2026-11-06-scheduled-tasks.md` («Unattended»): the new prompt blocks.
- `docs/specs/2026-11-23-schedule-earlier-results.md`: a note that the 10-run window is replaced.
