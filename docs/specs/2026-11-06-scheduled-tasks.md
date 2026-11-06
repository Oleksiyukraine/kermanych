# Scheduled tasks: reminders and agent runs on a schedule, set from ЦУК

- **Date:** 2026-11-06
- **Branch:** `feature/add-scheduled-tasks`
- **Scope:** `packages/core` (the schedule vocabulary, occurrence math, the `cuk.schedule.*`
  actions), `apps/api` (local tables, the scheduler, two runners, endpoints, socket events),
  `apps/ui` (ЦУК actions and cards, «Центр сповіщень» kinds and the «Розклад» tab, i18n `uk` /
  `en`), `apps/ui/src-electron` (background mode with a menu-bar icon), `kermanych/README.md`. No
  cloud migration.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-06),
  approved the same day; plan: `docs/plans/2026-11-06-scheduled-tasks.md`.

## Goal

The operator wants tasks on a schedule, the way Hermes Agent has them
(<https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>): said in plain language in
ЦУК and run on time. The examples:

- «генеруй звіт по проєкту X щовечора о 19:00, використовуючи навичку Y»;
- «щоранку перевіряй функціонал X»;
- «щоранку пропонуй одне нове покращення для платформи»;
- tasks not about code at all: «нагадай про міт з клієнтом», «нагадай випити вітаміни о 19:00».

## Context

- **A scheduler existed and was removed.** «Routines» (PR #161, removed on 2026-10-19,
  `docs/specs/2026-10-19-remove-routines.md`) «did not work the way the operator wanted». It
  was a Менеджмент section with a form editor, definitions in Supabase visible to the team with
  author/owner rights, a cloud runner (Edge Function, `pg_cron`, an Anthropic key), release notes
  and Slack as the main actions, and creating a routine from the chat was explicitly out of scope.
  This design takes the opposite turn on each of those points: chat first, personal, local,
  agent runs with skills.
- **The api lives and dies with the window.** It runs in Electron's main process
  (`apps/ui/src-electron/electron-main.ts:85-96`); `window-all-closed` quits the app (`:292`),
  and `before-quit` stops the agent children (`:294-307`). There is no tray icon.
- **Unattended launches already exist.** «Посіпака» polls every 60 s
  (`apps/api/src/minion/minion.service.ts:55`), claims a card and launches it with
  `supervisor.launchMinion`; its children get the no-ask overlay
  (`apps/api/src/minion/ask-overlay.ts`) and a time cap (`packages/core/src/minion.ts:18-20`).
  Every session launch needs a cloud card in a project (`SupervisorService.createSessionFromTask`,
  `supervisor.service.ts:1077-1220`) and the JWT the UI keeps refreshing, also while the window is
  hidden (`stores/auth.ts:84-87`).
- **Skills by name.** `SkillsService.assignedForNames(scope, names, cwd)`
  (`apps/api/src/skills/skills.service.ts:469`) turns any list of skill names into the prompt
  block a role gets; a repository skill wins over the library.
- **One-shot children.** ЦУК and the Менеджмент chat run on `assistant/rpc-chat-pool.ts`: a child
  on the user's backend, a per-key turn queue, timeouts, no session row.
- **Agent slots** come from the machine resource profile; a launch over the limit waits as
  `queued` and survives a restart (`docs/specs/2026-10-21-machine-resource-profile.md`).
- **Worktrees.** Archiving is a hide flag that keeps the worktree (`setArchived`,
  `supervisor.service.ts:2993-3009`). `finishSession` removes it and keeps the transcript
  (`:3336-3338`); `reopenSession` (`:3437`) brings a worktree back and the omp child resumes the
  conversation.
- **«Центр сповіщень»** is ЦУК's left column (`components/assistant/CukNotifications.vue`,
  `stores/notification-center.ts`), meant for several kinds of entries
  (`docs/specs/2026-11-04-skill-self-improvement.md`, decision 6); today it has one,
  `skill-improvement`, read from the cloud.
- **ЦУК actions** are a union in `packages/core/src/cuk-actions.ts`, validated in core, listed for
  the model in `apps/api/src/cuk/cuk-prompt.ts`, executed in the browser by `stores/cuk-chat.ts`;
  `cukNeedsConfirm` decides between «at once» and a card
  (`docs/specs/2026-11-04-cuk-control-console.md`, decision 4).
- **Local storage** is SQLite at `~/.kermanych/kermanych.sqlite`
  (`apps/api/src/registry/registry.service.ts:230`), with additive migrations in the constructor.

## Decisions

1. **Scheduled tasks are personal and machine-local.** Definitions and run history live in the
   local SQLite. Nobody else sees them; nothing runs as another member.
   - Rejected: definitions in the cloud visible to the workspace, run on the author's machine
     (Routines' model — the rights, triggers and migrations it needed). Rejected: a «share» that
     copies a task to a colleague.
2. **A scheduled agent only analyses.** It may read code, run tests and the live preview, and
   write a report. It never commits and never opens a PR. Its output is its final answer, plus
   findings through `report_finding` and, when its skill says so, a report file.
   - Rejected: runs that change code (a branch and commits per run — 30 branches a month for a
     daily task); a per-task «may change code» switch (deferred until a real need).
3. **Two kinds of scheduled task.**
   - **Нагадування** — no model, no subscription: at its time a slip lands in «Центр сповіщень»
     with a system notification, a Dock bounce and an in-app toast.
   - **Задача агента** — an analysis run (decision 2), with or without a project.

   ЦУК picks the kind from the phrase; the result line or the card shows which.
   - Rejected: everything as an agent run (every reminder spends the plan and a slot); agent tasks
     in a project only (no reminders, no news digest).
4. **Background mode while scheduled tasks are active.** With at least one enabled scheduled task,
   closing the window hides it instead of quitting: Kermanych stays with a menu-bar icon whose menu
   has «Відкрити Керманич», the next firing («Вітаміни · 19:00») and «Завершити». ⌘Q and
   «Завершити» quit. With no enabled scheduled task, closing quits as today. Running agents keep
   running while the window is hidden. The renderer is hidden, not destroyed, so the auth refresh
   keeps the api's token current.
   - Accepted: a sleeping Mac does not wake for a firing; the occurrence is handled by decision 8
     after wake.
   - Rejected: background mode always (changes the app for people who use no schedule); no change
     (a closed window silently stops every schedule).
5. **Every agent run in a project is a session, and sessions stay.** A run shows in «Агенти» with a
   «Розклад · <назва>» badge. The operator archives sessions himself.
   - Rejected: auto-archiving an opened run when the next one starts; no sessions at all (no
     follow-up question, no transcript).
6. **The schedule lives in «Центр сповіщень», ЦУК's left column, as a second tab.** The column's
   head gets «Сповіщення | Розклад».
   - **Сповіщення** gains three local kinds beside skill improvements, newest first, marked and
     counted as new:
     - a reminder fired: its text and time, «Готово»;
     - an agent run ended: the task's name, the first line of the result, «Відкрити сесію» (a
       project run) or the full text on opening (a run without a project, decision 9);
     - a run skipped or failed: the reason, and «Запустити зараз» where it applies.
   - **Розклад** lists the tasks: kind, project, the schedule in words, the next firing, a pause
     switch. Opening a row shows, over the console (as a skill improvement opens today), its
     prompt, skills, history of runs (time, status, a link to the session), «Запустити зараз» and
     «Видалити».
   - Local slips and cloud skill improvements merge into one feed by time.
   - Rejected: a single feed with a pinned «Найближче» block (no full overview with a dozen
     tasks); the right column beside the notepad; a section on «Агенти»; Settings.
7. **ЦУК confirms by weight, as for its other actions.**
   - **At once**, with «Скасувати» in the result line: create or edit a reminder; pause any task;
     resume a reminder.
   - **A card** («Виконати» / «Скасувати»): create or edit an agent task, resume an agent task,
     «запусти зараз». The card shows the project (or «без проєкту»), the editable prompt, the
     skills, the schedule in words and the next three firings.
   - **A card always:** delete any task (its history goes with it).
   - Rejected: a card for everything (a click for «нагадай про вітаміни»); everything at once (a
     misread «щогодини» spends the plan until noticed).
8. **A missed occurrence is caught up once, while it still matters.**
   - An agent task runs late only for its latest missed occurrence and only inside a window of half
     its period, clamped to 2–12 hours. Such a run is marked «із запізненням». Past the window, a
     «Пропущено» slip with «Запустити зараз» is written instead.
   - A reminder always lands as one slip for its latest missed occurrence, marked «пропущено»,
     however many were missed.
   - Rejected: always catching up the latest miss within 7 days (Routines — yesterday's report
     arriving on Friday evening); never catching up.
9. **An agent task without a project runs as a one-shot child, not a session.** It runs on the
   `rpc-chat-pool` mechanics in its own folder `~/.kermanych/schedules/<id>/`, with the task's
   skills, web search and page reading, on the user's backend. The whole answer is stored in its
   slip: the feed shows the first line, opening shows the text, «Обговорити в ЦУК» puts it into
   the ЦУК composer. Tasks in a project stay sessions (decision 5).
   - Accepted: no follow-up in the agent's own context; the follow-up goes through ЦУК.
   - Rejected: a session in an «Особисте» group with no card (a second launch path in
     `supervisor.service.ts`); no agent tasks without a project.
10. **A project run's worktree goes when the run ends; its session stays.** Nothing was committed
    (decision 2), so the worktree and its temporary branch are removed and the session keeps its
    transcript, as after «Завершити». A follow-up message reopens it through `reopenSession`,
    which forks a fresh worktree off the base branch and resumes the conversation.
    - Rejected: the worktree living until the session is archived (archive would act differently
      for these sessions alone, and worktrees pile up meanwhile); never removing it (a copy of the
      repository per run).

## Defaults not raised in the interview

- **Schedules:** once (a date and time, or «через N хв / год»), daily at HH:MM, weekdays
  (Mon–Fri), chosen days of the week, a day of the month (clamped to the month's last day), every
  N hours. A wall-clock time in the IANA zone of the machine at creation, stored on the task;
  daylight-saving gaps and doubled hours follow `Intl`'s «compatible» rule. No raw cron: ЦУК
  translates the phrase. A «once» task switches itself off after it fires. A «once» whose time has
  already passed is refused (`schedule_at_past`) on create, on rescheduling and on resume; moving
  a fired «once» to a future time turns it back on. «Через N хв» rounds up to the next whole minute.
- **Editing never fires the past.** A changed schedule or a resumed task is re-armed from the
  moment of the change.
- **Exactly once.** A run is claimed by inserting `(schedule_id, scheduled_for)` under a unique
  key; a restart cannot fire an occurrence twice. «Запустити зараз» has no `scheduled_for`.
- **Overlap.** An occurrence that comes due while the same task's previous run is still going is
  recorded as skipped («попередній запуск ще триває»).
- **Slots.** A project run takes an agent slot like any launch and waits in the queue when the
  slots are full. One-shot runs (decision 9) do not take a slot; they run one at a time per
  machine.
- **Background mode ends with the last live task.** The menu-bar icon stays while some task is
  enabled and has a next firing or a run in flight; a fired «once» does not keep it.
- **The first tick** runs 5 s after start, so a run never launches before the api listens.
- **Unattended.** Every agent run gets the no-ask overlay and «Посіпака»'s time cap. Its opening
  prompt says: a scheduled task «<назва>», nobody will answer, analysis only (decision 2), the
  first line of the final answer is a one-line summary, ideas and bugs go through
  `report_finding`. Deep analysis and design are never used for a run.
- **The model.** A project run takes the project's defaults (model, effort), as a launched agent
  from ЦУК does; ЦУК sets another model only when the operator names one. A one-shot run uses
  the user's backend default.
- **The project run's card** is hidden from the board (`hidden: true`), assigned to the operator,
  `autoRun: false`, titled «Розклад · <назва> · <дата>», branch `chore/schedule-<id prefix>`. If
  the launch fails, the card is deleted, so a failing daily task does not fill the backlog. A run
  still `running` when Kermanych restarts is failed and retired.
- **Preconditions are checked before anything is spent:** the project is bound on this machine,
  the operator is signed in (project runs only), every named skill resolves. A failing check
  writes one «не виконано» slip with the reason and spends nothing.
- **Skills.** ЦУК's per-turn context gains the skill names available to the operator (the library
  and the selected project's repository skills) and the list of scheduled tasks (id, name, kind,
  schedule, next firing, paused), so «постав на паузу вітаміни» can name one. An unknown skill
  name is refused at creation.
- **No recursion.** Only ЦУК creates scheduled tasks; agent runs have no tool for it.
- **Reminder slips** carry «Готово» and «Відкласти» (10 хв / 1 год); a snooze fires the same slip
  again later and leaves the schedule as it is.
- **Keep-awake.** A running agent run holds the same `prevent-app-suspension` blocker «Посіпака»
  uses; nothing keeps the Mac awake between firings.
- **Retention.** The latest 50 runs per task and the latest 200 local slips are kept; older rows
  are dropped, except the run holding the task's latest occurrence, which keeps it from firing
  twice. Deleting a task removes its runs (one in flight ends silently) and keeps its slips.
- **Notifications** follow the existing path: a toast with «Переглянути» (opens ЦУК on the slip),
  an HTML5 notification while the window is unfocused or hidden, a Dock bounce. An unsigned build,
  where macOS refuses notifications, keeps the toast, the bounce and the slip.
- **Naming.** The tab is «Розклад» (`en`: «Schedule»); kinds «Нагадування» / «Задача агента»
  (`en`: «Reminder» / «Agent task»).

## Implementation

- **core:**
  - `schedules.ts` — `ScheduleKind` (`reminder` | `agent`), `ScheduleSpec` (the presets above)
    and `ScheduleWhen` (a spec or «через N хв»), `ScheduledTask`, `ScheduleRun` (statuses
    `running`, `done`, `skipped`, `failed`, and reasons), `ScheduleSlip`;
    `validateScheduleSpec` / `validateScheduleDraft` / `validateSchedulePatch` with stable refusal
    codes; `zonedInstant`, `nextOccurrences`, `latestOccurrence`, `catchUpWindowMs`,
    `dueOccurrence` (the decision 8 window), `describeSchedule` for the card and the list.
  - `cuk-actions.ts` — `schedule.create`, `schedule.update`, `schedule.pause`,
    `schedule.resume`, `schedule.run`, `schedule.delete`, their validators, and
    `cukNeedsConfirm` per decision 7. Rejection codes in `i18n-codes.ts`.
  - `ServerEvent` gains `schedules_update` (the whole list), `schedule_slip` (a slip written or
    re-fired by a snooze) and `schedule_run_update`.
- **api:**
  - Registry: tables `schedules`, `schedule_runs` (unique `(schedule_id, scheduled_for)`),
    `schedule_slips`.
  - `schedules/schedule.service.ts` — the minute tick (`unref`) and one tick at start (a timer
    resumes after the Mac wakes, so the next tick sees the missed occurrence), the claim, the
    overlap skip, the catch-up window, the once switch-off, re-arming, retention, snoozes.
  - Runners: reminders write a slip; project runs file the hidden card and launch through
    `createSessionFromTask` with the scheduled opening prompt, `assignedForNames` skills, the
    no-ask overlay and the time cap, then retire the worktree on the run's end (decision 10);
    one-shot runs go through `rpc-chat-pool` with the task's folder as cwd.
  - `http/schedules.controller.ts` — list, create, update, pause/resume, run now, delete, slips
    (list, mark seen, snooze).
  - `cuk/cuk-prompt.ts` — the schedule verbs, the kinds, the analysis-only rule, the skill names
    and the task list in the context block.
- **electron:** the menu-bar `Tray` and its menu; `window-all-closed` and the window's `close`
  hide instead of quitting while the api reports an enabled task (`bootstrap({ schedules })`);
  ⌘Q and «Завершити» quit.
- **ui:**
  - `stores/schedules.ts` — the list, run history, slips; the socket events.
  - `stores/notification-center.ts` — `NotificationItem` gains `schedule-slip` (a reminder or a
    run: done, skipped or failed); one feed by time.
  - `CukNotifications.vue` — the «Сповіщення | Розклад» tabs, the new slips; a schedule detail
    view over the console.
  - `stores/cuk-chat.ts`, `CukActionCard.vue` — the schedule actions and their card fields.
  - «Розклад · <назва>» badge on run sessions in «Агенти»; i18n `uk` / `en`.

## Verification

- `pnpm --filter @kermanych/core test`: 438 passed. `test/schedules.spec.ts` covers the
  occurrence math across both Kyiv DST changes, weekdays, chosen days, the 31st in a short month,
  every N hours in a +05:30 zone; the due rule — on time, late inside the window, missed outside
  it, reminders always firing, never at or before arming or the last claim; the validators and
  `resolveWhen`. `cuk-actions.spec.ts` covers the schedule kinds and `cukNeedsConfirm` per
  decision 7, an unknown ref meaning a card.
- `apps/api` `vitest run`: 1365 passed, 4 skipped. `test/schedules.spec.ts` and
  `test/registry.schedules.spec.ts` cover:
  - the tick on its own timer; one claim per occurrence, a restart not refiring; the overlap
    skip; catch-up inside and a «Пропущено» slip outside the window; the once switch-off; re-arming;
  - a pause, a delete and a rename made while an earlier task of the same tick is launching;
  - a past «once» refused on create (service and 400), on resume; re-enabling by rescheduling;
  - a project run's hidden card, skills block, analysis-only prompt, a failed launch deleting the
    card, the run's end writing the slip and retiring the worktree, the time cap failing it;
  - a one-shot run's folder and stored answer; precondition failures spending nothing; delete
    during a run releasing keep-awake and writing no slip; snooze re-firing; retention keeping
    the dedupe row.
- `apps/ui` `vitest run`: 961 passed (feed merge and new count, the slip toast, undo mapping,
  every rejection code and run reason in both locales). `tsc --noEmit` (api) and `vue-tsc
  --noEmit` (ui with `src-electron`, against the built api) are clean.
- Live preview (`KERMANYCH_PREVIEW=1`, real ЦУК model):
  - «Нагадай мені через 1 хвилину випити воду» → a reminder created at once with «Скасувати» in
    the result line, the row in «Розклад»; at 22:44 the slip landed in «Сповіщення» with «Готово»
    and «Відкласти», the toast with «Переглянути» and the character's dot; the «once» task then
    showed «на паузі»;
  - «Щоранку о 9:00 без проєкту: …» → a card with «без проєкту», the editable text and the next
    three firings; «Виконати» created it; «Запустити зараз» in its view ran the one-shot agent,
    the history showed «виконується» then «виконано» with the summary, and a slip with
    «Відкрити» and a toast arrived;
  - «Постав «Пораду дня» на паузу і видали нагадування «Вода»» → the pause ran at once with
    «Скасувати», the delete came as a card and removed the task on «Виконати»;
  - `POST /schedules` with a past «once» answered 400 `schedule_at_past`.
- Review: a code review of the change found five issues (stale rows in the tick, keep-awake held
  after a delete mid-run, a past «once» keeping background mode on, retention dropping the dedupe
  row, a list update blanking the first feed load); all five are fixed with the tests above.
- **Not exercised:** a project run end to end (the preview's seeded projects point at
  non-existent paths and it has no cloud board — covered by the api tests with a fake supervisor
  path); the Electron build (the menu-bar icon, hiding on close, ⌘Q) — only typechecked.

## Documentation

`kermanych/README.md` → the ЦУК section gains «Розклад»: the two kinds, how to ask ЦУК, what is
confirmed, missed occurrences, background mode and the menu-bar icon, where results land, the
analysis-only rule.
