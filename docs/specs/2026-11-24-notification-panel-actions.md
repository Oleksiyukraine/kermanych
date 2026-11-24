# «Видалити сповіщення» and «Створити задачу» in the slip view

## Goal

The panel that opens over the console when the operator clicks a scheduled-task slip in
«Центр сповіщень» (`ScheduleSlipView.vue`) ends with links that lead away from the result:
«Відкрити задачу», «Відкрити сесію» and, for a run without a project, «Обговорити в ЦУК». The
operator sees no point in them. The panel must offer two actions instead:

1. **«Видалити сповіщення»** — the slip leaves the feed for good.
2. **«Створити задачу»** — ЦТ closes and the «Нова задача» popup opens with the description
   already filled in from the slip.

## Context

- Slips are this machine's: the SQLite table `schedule_slips` (`registry.service.ts`), served by
  `GET /schedules/slips`, marked seen by `POST /schedules/slips/seen` and hidden for a while by
  `POST /schedules/slips/:id/snooze`. Nothing could delete one. The newest
  `SCHEDULE_SLIPS_KEEP = 200` are kept.
- A slip is a reminder (`kind: 'reminder'`) or an agent run (`kind: 'run'`, with `status`,
  `runId`, `projectId`, `sessionId`, and `body` — the whole answer — for a run without a
  project). A failed or skipped run shows its reason (`reasonText`) instead of the text.
- The «Нова задача» popup is the launcher of «Агенти» (`AgentsPage.vue`). It has no project
  field: the project comes from outside (`launchProjectId`) and shows as a tag in its head.
  `openTaskFromText(text)` already opens it prefilled from a transcript selection, with the
  title derived from the text's first line (`taskNameFromText`) and no draft kept.
- A link from outside a page asks that page for something through a request object on the
  orchestrator store that the page consumes and clears (`fileOpenRequest` /
  `openSessionFile`).
- A run's reaction «Взято в роботу» (`docs/specs/2026-11-23-scheduled-task-run-memory.md`,
  decision 2) tells the next runs not to repeat that result.

## Decisions

1. **Only schedule slips change.** A skill improvement keeps «Відкотити» and «Поширити на
   команду», and an update keeps its notes. (Operator.)
   - Rejected: a delete for skill improvements too. Their records form the chain that
     `rollbackPlan` and `copyOrigin` read; deleting one from the middle breaks the rollback of
     later changes.
2. **The footer holds exactly two buttons; all three old ones go.** «Відкрити задачу»,
   «Відкрити сесію» and «Обговорити в ЦУК» are removed. (Operator.) The task stays reachable
   from the «Розклад» tab, and the session from «Агенти».
   - `cuk-chat.discuss`, its `draftRequest` and CukAssistant's watcher had no other caller and
     are removed with the button, as are the i18n keys `slip.openTask`, `slip.discuss` and
     `slip.discussDraft`.
3. **The task goes to the slip's project, else to the selected project.** With neither (a
   reminder or a run without a project while no single project is selected), «Створити
   задачу» is disabled and its tooltip says «Виберіть проєкт у перемикачі вгорі». (Operator.)
   - When the project lies outside the current scope, the scope moves to it first, as
     «Відкрити сесію» did, so the new card is seen in the backlog.
   - Rejected: always the selected project; a project picker in the popup (it is the shared
     form of every «Нова задача» entry).
4. **The description is a source header plus what the panel shows.** (Operator.)
   - A finished run: `Результат задачі за розкладом «{name}» ({when}):`, a blank line, then the
     whole answer (`body`, else `text`).
   - A failed or skipped run: `Задачу за розкладом «{name}» не виконано ({when}):`, a blank
     line, then the reason, as the panel shows it.
   - A reminder: `Нагадування «{name}» ({when}):`, a blank line, then its text.
   - `{when}` is the firing time as the panel shows it (`formatFiring`). The title comes from
     the first line of the text, not from the header, and stays editable.
   - Rejected: the bare text (no one on the board can tell where the card came from).
5. **A card created from a finished run marks that run «Взято в роботу».** (Decided in the
   unattended run, on the recommendation the operator was asked about.)
   - Only once the card exists (the popup's «Зберегти в беклог» or «Запустити» wrote it); a
     popup closed without a card changes nothing.
   - Only for a run that takes a reaction: `done`, its task still in the schedule, the run still
     in the task's history. A reaction already «Взято в роботу» is left alone; «Не цікаво» is
     replaced.
   - A failed save is a toast; the card stays.
   - The slip itself stays; deleting it is the other button.
   - Rejected: nothing automatic (a forgotten reaction makes the next runs repeat the result);
     deleting the slip too (removes what the operator may still want to read).
6. **«Видалити сповіщення» deletes at once, with no confirmation, and closes the panel.**
   (Decided in the unattended run.) It sits next to «Готово» and «Відкласти» in weight: a
   notification, not a record of work. The run, its summary, notes and reaction stay in the
   task's history; only the slip goes. The button spins while the request runs; a refusal is a
   toast and the panel stays.
   - New route `DELETE /schedules/slips/:id` (404 for an unknown slip), like the snooze.
7. **The popup is the existing launcher, opened through a request.** `orchestrator` gets
   `newTaskRequest` / `requestNewTask({ projectId, text, title, onCreated })`. The panel
   closes itself and ЦТ, sets the request and routes to «Агенти»; `AgentsPage` consumes it with
   `openTaskFromText` (now taking the project and title) and calls `onCreated` once
   `board.createTask` answers with the card. No project-draft is written: this prefill is not
   the operator's «Нова задача» draft.
   - Rejected: a second task form inside ЦТ (a second convention for one form).

## Changes

- `apps/api`: `RegistryService.deleteScheduleSlip`, `ScheduleService.deleteSlip`,
  `DELETE /schedules/slips/:id`; tests in `test/schedules.spec.ts` and
  `test/registry.schedules.spec.ts`.
- `apps/ui`:
  - `lib/api.ts` `deleteScheduleSlip`; `stores/schedules.ts` `removeSlip`.
  - `stores/orchestrator.ts` `newTaskRequest`, `requestNewTask`.
  - `pages/AgentsPage.vue`: `openTaskFromText(text, projectId?, title?)`, the request watcher,
    the `onCreated` hook after a new card.
  - `components/assistant/ScheduleSlipView.vue`: the two buttons; the old three and their
    handlers go.
  - `stores/cuk-chat.ts`, `components/assistant/CukAssistant.vue`: `discuss` and
    `draftRequest` go.
  - i18n `uk` / `en`: `slip.delete`, `slip.createTask`, `slip.noProject`, the three headers,
    `slip.reactFailed`; the obsolete keys go.
- `README.md` («Задачі за розкладом → Where to see them»): the panel's actions.

## Verification

- API tests: a deleted slip is gone from `slips()`; an unknown id is a 404.
- UI typecheck.
- Live preview: open a run slip → «Створити задачу» closes ЦТ, opens «Нова задача» on «Агенти»
  with the header and the answer, in the slip's project; «Зберегти в беклог» sets «Взято в
  роботу» on the run. «Видалити сповіщення» removes the slip from the feed and closes the panel.
