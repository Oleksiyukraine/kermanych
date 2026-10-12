# «Документація» and «Сесія» survive a restart

- **Date:** 2026-10-12
- **Task:** session `problema-z-sektsiieiu-dokumentatsiia`, filed 2026-10-09 as «Глибокий аналіз».
- **Scope:** `supabase/migrations` (two `tasks` columns), `packages/core`, `packages/cloud`,
  `apps/api`, `apps/ui` («Агенти»), README.
- **Builds on:** `af57688` (the tab), `5587670` (one deterministic mechanism),
  `docs/specs/2026-10-05-docs-mid-session.md`.

## Goal

The operator reported that a session's «Документація» tab fills while the agent works and still
looks right after the agent finishes. After Kermanych restarts, though, the same tab reads «Ця
сесія не читала й не змінювала документацію.», for a session that read 4 documents and changed
9. An earlier task was meant to fix this. The tab's data must survive a restart and «Завершити»,
and it must be kept where every member of the workspace can read it, not on one machine. The
same holds for the «Сесія» tab.

## Context

- **How the tab is built.** Both lists are derived in the UI (`apps/ui/src/pages/AgentsPage.vue`):
  - «Використана документація» is `docsRead(entries)` (core `docs.ts`) over the transcript in
    `store.transcripts[id]`;
  - «Створено або оновлено» is `changesInfo.files.filter(isDocPath)`. `changesInfo` comes from
    `GET /sessions/:id/finish` (`SupervisorService.finishInfo` → `WorktreeService.changedFiles`),
    which diffs the worktree against `merge-base(HEAD, baseBranch)`.
- **Cause 1: documents read.** After an API restart no session has a `Live`. `getTranscript(id)`
  then serves one synthesised notice (`session_dormant_inactive` / `session_dormant_merged`), so
  `docsRead` is empty for every managed session until it is resumed. «Скіли» on «Сесія»
  (`skillsUsed`) and the task images (`taskImages`, read off the first `user_text` of the log)
  vanish the same way. «Контекст» (`contextPercent`) is live-only. Native sessions are not
  affected, because `NativeSessionService.transcript` reads the harness's own file.
- **Cause 2: documents changed.** `finishSession` commits loose work, removes the worktree and
  stores `status: merged, worktreePath: ""`. `worktreeGone` then stops `loadChanges`. The tab
  keeps the stale in-memory `changesInfo` only until the session is re-selected or the UI
  reloads. Its rows then fail: the diff pane and the «Задача з документа» dialog show the raw
  API error `session has no worktree — reopen it to continue`. For in-place sessions
  (`worktree: false`), `finishInfo` after finish diffs whatever the project checkout is on.
- **The data is unreachable, not lost.** For session `11aca120…` (`merged`, `pr_opened = 1`),
  the omp session file still holds the same 4 reads, and the kept branch gives the same 107
  files, 9 of them documents. But PR #25 was merged into `origin/dev` with a merge commit. Once
  `dev` is pulled, `merge-base(dev, branch)` is the branch tip and the diff is empty, so
  recomputing from git at view time is unreliable.
- **Prior work.** `4487998` read a librarian doc-report off the card. `5587670` dropped it, and
  its column `tasks.doc_report` (`20260910100000` → `20260915120000`), for one deterministic
  mechanism: transcript plus diff. The report was dropped for its content (a free-form list
  that drifted from the real one and leaked `.ts` paths), not for where it was stored. `ac2fd6c`
  («show a dormant session's history on open», branch `feature/pryvit`) was never merged and
  would cover cause 1 only.
- **What teammates share.** Sessions are local: «Агенти» lists this machine's registry rows plus
  the operator's own backlog cards. The only shared surface is the cloud card (`tasks`, on
  `supabase_realtime`). RLS `is_project_member` lets any member of the project's workspace read
  it. The QA checklist already lives there (`tasks.qa_checklist`, written by the API through
  `patchTask`, shown in the «Дошка» card dialog and in the «Агенти» QA tab via `linkedTask`). The
  board store is subscribed app-wide (`MainLayout` → `board.subscribe()`).
- **What the card says about a session.** It has the mirrored `status`, the `description`,
  `imagePaths`, and the launch requests `model`, `effort`, `worktree` and `branch`. `branch` is
  the requested fork base (`resolveLaunchParams(…, requestedBase)`), not the agent's working
  branch. `model` is what was requested (`validModel` may drop it, the composer may switch it,
  a native session has none). A card can be relaunched after a terminal status, so a later
  session of the same card replaces an earlier one's data. On this machine (2026-10-12) each of
  154 cards has exactly one session. Every agent session since 2026-09-15 has a card; 53 older
  agents, the 22 chats, and every discussion and review have none.
- **Card images.** The «Агенти» launcher creates the card without images
  (`board.createTask(taskInsertFromDraft(…))`) and hands them only to the agent's first message
  (`createSessionFromTask(cardId, images)`). Only «Дошка»'s form uploads images to the card
  (bucket `task-images`, `tasks.image_paths`). Nothing reads them: `signedTaskImageUrls` has no
  caller, and the board's ▶ launches with no images.
- **`tasks_guard()`** (latest body in `20260830090000_tasks_assignment.sql`) sets
  `updated_at := now()` on every UPDATE. The kanban card face prints that age, the board orders
  by `createdAt`, and the store's `upsert` replaces a row on any realtime event.
- **What a backfill could recover** (measured here on 2026-10-12 over 153 agent sessions with a
  card): a history file exists for 149 (the other 4 are claude-code, which deletes transcripts
  after 30 days).
  Changed documents are computable for about 119: 9 live worktrees, 15 kept branches not yet
  merged, and 95 branches merged with a merge commit. For those, the fork point is
  `merge-base(M^1, tip)`, where M is the oldest commit in `git rev-list --first-parent
  --ancestry-path tip..base`. Not computable: 12 deleted branches, and 22 merged without a merge
  commit or empty.

## Decisions

1. **Scope.** The two «Документація» lists and the «Сесія» data survive a restart and
   «Завершити». Every member of the workspace can read them. The «Лог» is unchanged: a dormant
   session still shows its notice. Rejected:
   - local storage (a SQLite session row): the operator first picked it, then rejected it
     because teammates could not see the data;
   - reviving `feature/pryvit` (read the history on open): it also changes the «Лог», old claude
     sessions would lose the lists again after 30 days, and «Створено або оновлено» would still
     need a copy taken at finish;
   - recomputing «Створено або оновлено» from the kept branch at view time: see the merge-commit
     collapse above.
2. **Storage: the card, one column per tab** (operator). `tasks.docs_report` holds
   «Документація» and `tasks.session_report` holds «Сесія», the way `tasks.qa_checklist` holds
   the QA tab. The name `doc_report` is not reused. Each report carries the `sessionId` it
   describes, so a session's own tab ignores a report written by another session (a relaunch of
   the card). Both columns go in one `patchTask`: one UPDATE, one realtime event. Rejected: one
   column for both tabs (the operator: two tabs, two kinds of data); a cloud table with a row
   per session (a new table, RLS and mappers, while a card has one session at a time).
3. **What `session_report` holds** (operator). It holds what a teammate cannot get from the
   card:
   - the harness (omp / claude, managed / native);
   - the model and effort the agent actually ran with;
   - the working branch, the base, worktree yes/no;
   - «Скіли»;
   - tokens and cost;
   - the provider session id (the Kermanych session id is the report's `sessionId`).

   Not stored: description and status (already on the card), «Контекст» (live-only), and paths
   on the author's disk (a native omp session file, the worktree path). Cost becomes visible to
   every member of the workspace; the operator accepted this. Images do not go into the column,
   because they are megabytes on a row broadcast to every member; see decision 11. Rejected:
   «Скіли» only (teammates would still see nothing of the session); the whole tab verbatim (a
   live figure and local paths).
4. **What teammates see is a separate task** (operator). This task writes both columns and makes
   the session's own tabs in «Агенти» read them back. Showing the reports to teammates is the
   separate task: sections in the «Дошка» card dialog, Jira/Linear ticket views, card images in
   that dialog, and the working branch on the kanban card. It will find the columns filled for
   every card worked after this change ships.
5. **A finished session's document rows are a list** (operator). After «Завершити»
   («Створено або оновлено» comes from the card), a row shows path, kind tag and +/−. It does
   not expand, and «Задача →» is hidden. One line above the list says the worktree was removed
   and that «↻ Відновити» brings back the diff and «Задача →». Rejected: diff and text from git
   after finish (fork point and tip saved at finish), because they are lost after a squash merge
   once the branch is deleted, and `fileDiff` / `sessionFile` would need a second path for
   finished sessions.
6. **No backfill** (operator). Reports start with the first turn or «Завершити» after the update.
   Sessions from before it, `11aca120…` included, keep today's behaviour. `tasks_guard()` stays
   as it is. Rejected:
   - a one-time backfill when the API starts (history files plus the branch, with the
     merge-commit fork recovery above; it would also need `tasks_guard()` to stop bumping
     `updated_at` for report-only writes, or about 150 cards would read «щойно» for everyone);
   - backfill when an old session is opened.
7. **When the API writes.** It writes for an agent session that has a card:
   - at the end of every turn (managed: a terminal `agent_end`; native: the history the
     supervisor receives after each turn);
   - in «Завершити», before the worktree is removed (in-place: before the checkout back to the
     base).

   A session without a card (chats, discussions, reviews, agents from before cards) writes
   nothing.
8. **What a write holds and how it merges** (core `mergeTaskReports`, a pure function). A write
   is built from the session's own sources:
   - documents read and skills come from the full transcript (`Live.transcript`; for a native
     session, the history the turn just read);
   - documents changed come from `changedFiles` filtered by `isDocPath`, capped like the
     «Зміни» listing (500);
   - the rest of `session_report` comes from the registry row.

   «Завершити» on a session with no `Live` (dormant after a restart) sends no reads and no
   skills. Merging works like this:
   - **Same session.** Reads and skills accumulate (a union in first-seen order), so a compacted
     or freshly rehydrated transcript never shrinks them. The changed list and the other
     `session_report` fields are replaced by the latest write, so a reverted document drops out.
   - **Another session.** Its report is replaced only if the incoming write is newer
     (`generatedAt`). Otherwise the write is dropped, so a stale queued report of an old session
     never overwrites the card's relaunch.

   Rejected: replacing the reads on every write (a dormant finish would wipe them, a compaction
   would shrink them); reading omp's session file at finish (a second reader of omp's format for
   one edge case).
9. **Delivery: a local outbox.** `report_outbox` in the registry keeps one row per card holding
   the merged pending write. CloudSyncService drains it like `status_outbox`: retries with
   backoff, and the queue survives restarts and offline periods. A drain is `getTask` →
   `mergeTaskReports` → `patchTask`. A card that is gone or no longer readable drops its row.
   Known limit: if the API restarts before the queue drains (offline), the tab is empty until it
   does. Rejected: fire-and-forget like the QA checklist (`applyTaskArtifact`), because a session
   run offline would never publish its report.
10. **How «Агенти» reads.** A card report counts only when its `sessionId` is this session's.
    - «Використана документація» and «Скіли» are the union of the card's list and the live
      transcript's.
    - «Створено або оновлено» is the live «Зміни» listing while the session has its worktree,
      with the card's list shown until the first listing arrives. Once the session is finished
      (`merged`) or its worktree is gone, it is the card's list, shown list-only (decision 5).
    - Task images are the log's; failing that, the card's `imagePaths` through
      `signedTaskImageUrls`.
    - The rest of «Сесія» keeps reading the local row.
11. **Launcher images go on the card.** On create, `board.createTask(input, files)`. On an edit
    (a backlog card launched from «Задачі»), they are uploaded and appended to `imagePaths`.
    Each image is uploaded once, so a retry after a failed launch does not upload again. Only
    images the launch actually sends are uploaded (a native launch sends none).

## Changes

- **Cloud:** migration `kermanych/supabase/migrations/20261012090000_task_reports.sql` adds
  `tasks.docs_report jsonb not null default '{}'` and `tasks.session_report jsonb not null
  default '{}'`, commented like `qa_checklist`. Grants, RLS, `tasks_guard()` and realtime cover
  them as they are. It must be applied before the client ships: `TASK_COLUMNS` selects the
  columns by name, so without them every task read fails.
- **Core:** `task-reports.ts` with `DocsReport`, `SessionReport`, the write shape and
  `mergeTaskReports`, exported from the package.
- **`@kermanych/cloud`:** `Task` / `TaskPatch` get `docsReport` and `sessionReport`;
  `TASK_COLUMNS`, `toTask` (an empty object maps to an absent key) and `toTaskRow` are updated.
- **API:**
  - registry: `report_outbox` and its enqueue / list / drop / bump methods;
  - supervisor: builds the write on a terminal `agent_end`, on a native turn's history and in
    `finishSession` before the worktree is removed;
  - CloudSyncService drains the new outbox and is woken by the registry when a row is queued,
    with no new socket event.
- **UI:**
  - AgentsPage: the «Документація» lists and the list-only finished state with its hint line;
    «Скіли» and task images on «Сесія»;
  - the launcher uploads its images; board store `addTaskImages`;
  - i18n uk/en: the finished hint, and `agents.docs.usedHint` now says the list is kept on the
    task card.
- **README:** «Project documentation».

## Verification

To be filled in after implementation. Planned:

- `pnpm --filter @kermanych/core test`: the merge rules (union, replace, another session newer
  or older, missing parts of a write).
- `pnpm --filter @kermanych/cloud test`: the two columns in `toTask` / `toTaskRow`.
- `pnpm --filter @kermanych/api test`:
  - a write on `agent_end`, on a native turn, and in «Завершити» before the worktree is gone;
  - a dormant «Завершити» keeps the card's reads;
  - the outbox drain merges, drops a missing card's row, and never overwrites a newer session;
  - a session without a card writes nothing.
- `pnpm --filter @kermanych/ui test`: the launcher uploads each image once.
- Smoke on a local Supabase stack (`supabase start` with this migration), with the API and UI
  from this worktree:
  1. A session reads one document and writes another.
  2. Both columns are set on the card (`psql`).
  3. Restart the API: «Документація» and «Скіли» still show both.
  4. «Завершити»: the list-only state and the hint line appear.
  5. Restart again: the tab still shows everything.

## Documentation impact

`kermanych/README.md` «Project documentation»: the tabs survive a restart. It says where the
data lives (`tasks.docs_report`, `tasks.session_report`), when it is written, that sessions
from before the change are not backfilled, and that the migration must be applied before the
client ships.

## Out of scope

- Showing the reports to teammates (decision 4).
- Sessions without a card.
- The «Зміни» tab of a finished in-place session still diffs the project checkout.
- The board's ▶ does not send the card's images to the agent.
- The kanban card prints the base as its branch.
