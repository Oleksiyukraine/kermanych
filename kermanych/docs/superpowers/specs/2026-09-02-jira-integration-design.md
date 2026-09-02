# Jira Integration — Design Spec

Date: 2026-09-02. Status: approved in brainstorming; review gate waived by the operator.

## Goal

Every workspace can connect exactly one Jira board. The board is mirrored 1:1 into
Kermanych's «Дошка» — columns, statuses, labels, tickets, comments, worklogs,
attachments — following Kermanych's UI. Interaction is two-way: an action taken in
Kermanych (transition, comment, log work, edit, create, delete, attach) is written to Jira
immediately under the acting user's own Jira identity. A mirrored ticket can be
launched like a native task: the launch creates a local agent session and moves the
ticket to a user-chosen Jira status; when the session is merged, the user is prompted
to pick the ticket's next status.

## Decisions (agreed in brainstorming)

1. **Faithful mirror, separate view.** The Jira board is NOT force-mapped into the
   native five lifecycle columns. «Дошка» gains a two-tab switcher when the scoped
   workspace has an active integration: «Задачі» (native board, unchanged) and «Jira»
   (mirrored board with Jira's own columns). No integration → no switcher.
2. **Per-user API tokens.** The workspace integration names the site + board (owner
   connects it); each member enters their own Atlassian API token to interact. All
   writes to Jira happen under the actor's token → correct attribution in Jira.
   Members without a token get a read-only mirror.
3. **One Jira board per workspace.** Picked from a list at connect time; changeable
   later on the Integrations tab.
4. **Launch asks two things.** Which Kermanych project (= git repo) to run in —
   pre-selected from the sidebar's current project scope — and which Jira status to
   move the ticket to (pre-selected to an In-Progress-category status; the status
   picker is hidden when the ticket is already in an In-Progress-category status:
   "don't move it"). On `merged`, a prompt lists the board's statuses and applies the
   chosen transition; skippable.
5. **V1 scope.** Reads: columns, tickets (key, summary, type, priority, labels,
   assignee, status, description, time tracking — original estimate, time spent,
   remaining estimate — start & due date), comments, worklogs, attachment metadata +
   download. Writes: transitions (drag), comments, **worklogs — log, edit, delete**,
   create/edit/delete tickets, assignee, labels, standard fields, attachment
   upload, subtask creation.
   **Standard fields only are editable** (summary, description, type, priority,
   assignee, labels, original estimate, due date); other custom fields render
   read-only. Out of v1: custom field editing, sprint/backlog management, worklog
   visibility restrictions.
   **Time entries** are Jira's own dialogs, field for field: `timeSpent` in Jira's
   duration spelling, `started` (defaulted to now when logging, REQUIRED when editing
   so a correction cannot restamp the entry; sent as an instant and re-spelled for the
   worklog endpoints' `yyyy-MM-dd'T'HH:mm:ss.SSSZ`), an optional ADF description, and
   the remaining-estimate adjustment.
   That adjustment is three vocabularies, because Jira's three endpoints differ and the
   UI must not offer what one of them would refuse: POST takes
   `auto|leave|new|manual` with `newEstimate`/**`reduceBy`**, DELETE takes the same four
   with `newEstimate`/**`increaseBy`** (removing an entry gives the time back), and PUT
   has **no relative form at all** — only `auto|leave|new`.
   Every write is signed with the acting member's token, so the entry carries their name
   in Jira, and the issue refetch that follows moves `time_spent`/`remaining_estimate`
   in the mirror without waiting for the next poll.
   **Who may touch an entry is Jira's answer, not ours.** `GET /rest/api/3/mypermissions`
   is asked for `WORKLOG_EDIT_OWN`, `WORKLOG_EDIT_ALL`, `WORKLOG_DELETE_OWN` and
   `WORKLOG_DELETE_ALL` in the board's project; an entry is «own» when its mirrored
   `author_account_id` matches the token's own accountId (recorded from `/myself` when
   the token is stored, backfilled on first need for tokens saved earlier). A refused or
   unreadable permission answer degrades to all-false: the entries render, no edit or
   delete control appears.
   The one exception is **start date**: Jira has no system field for it, so the api
   resolves the site's own «Start date» (or Advanced Roadmaps' «Target start») from
   `GET /rest/api/3/field`, caches the id per site, and mirrors/edits through it. A site
   with no such field reports `startDateSupported: false` and the editors hide the
   control rather than offering a save Jira must refuse.
6. **Jira is the source of truth.** The mirror is a cache; disagreement resolves by
   overwriting the mirror from Jira. No merge logic.

## Architecture

```
UI (Jira view) → local NestJS api (JiraModule) → Jira Cloud REST (user token)
                                    ↘ Supabase mirror (user JWT, member RLS)
Supabase mirror → realtime/refetch → every member's UI (token or not)
```

- **All Jira HTTP goes through `apps/api`** — Jira REST forbids browser CORS and the
  api is where secrets belong.
- **Tokens are local-only**: registry SQLite `~/.kermanych/kermanych.sqlite`, keyed
  by site + Supabase user id. Never written to the cloud (the `localRepoPath` rule).
- **The mirror lives in Supabase**, workspace-scoped, member RLS (the
  `workspace_risks` pattern), so tokenless/offline-teammate members still see the
  last state.
- **Asymmetric sync.** Doshka→Jira: immediate (API call per action; on success the
  api also patches the mirror row). Jira→Doshka: polling — the UI ticks
  `POST /jira/sync/:workspaceId` every ~30 s while the Jira view is open; a lease in
  `jira_sync_state` keeps N open clients ≈ 1 poller.

## Data model

### Supabase (new migration)

- `workspace_jira_integrations` — one per workspace (`workspace_id` unique):
  `site_url`, `jira_project_key`, `board_id`, `board_name`, `connected_by`,
  timestamps. Owner-only insert/update/delete; member select.
- `jira_sync_state` — member-writable lease split from the owner-owned integration
  row: `integration_id` (pk/fk), `last_synced_at`, `sync_cursor` (high-water Jira
  `updated` timestamp for incremental JQL).
- `jira_columns` — `integration_id`, `position`, `name`, `status_ids text[]` (one
  Jira board column maps several statuses).
- `jira_issues` — card + detail body: Jira `issue_id`, `key`, `summary`,
  `description` (rendered), type/priority (name + icon URL), `labels text[]`,
  `original_estimate` / `time_spent` / `remaining_estimate` (Jira's time tracking, its own
  duration spelling; the last two move when work is logged),
  `start_date` / `due_date` (Jira's `YYYY-MM-DD`, blank = unset),
  assignee/reporter (accountId, display name, avatar URL), `status_id`,
  `status_name`, `status_category` (`new`/`indeterminate`/`done`), `parent_key`,
  `jira_updated_at`; launch binding: `kermanych_project_id`, `task_id`. Upsert key
  `(integration_id, issue_id)`. Full resync deletes rows absent from Jira. Member
  RLS. Added to the `supabase_realtime` publication.
- `jira_comments`, `jira_worklogs`, `jira_attachments` — child rows per issue;
  worklogs carry `author_account_id` (Jira's identifier, not a name — the own-versus-all
  permission question is answered from it); attachments are metadata only (filename,
  size, mime, author, created). No realtime; refetch on dialog open.

### Tasks table

One nullable column: `jira_key text`. Launch creates a **shadow task**
(`KAN-42 — <summary>`, description = ticket description, assignee = launcher) that
runs through the unchanged pipeline: `createSessionFromTask`, worktree, status
outbox, force-stop. The native board filters `jira_key is null`; the Jira view joins
the shadow task via `jira_issues.task_id` for a live agent-status chip.

### Registry SQLite (local)

`jira_tokens(site_url, user_id, email, api_token, account_id)` — `account_id` is the
token's own Jira identity from `/myself`, stored so «is this entry mine?» costs no call.

## Local API — `JiraModule`, `/jira/*`

- Token: `PUT /jira/token` (validated against Jira `/myself` before storing),
  `GET /jira/token/status`, `DELETE /jira/token`.
- Connect: `GET /jira/boards?site=` → `POST /jira/integrations` (writes integration
  row + columns, runs first full sync) → `DELETE /jira/integrations/:workspaceId`.
- Sync: `POST /jira/sync/:workspaceId` — honors the lease (take only if
  `last_synced_at` older than 25 s; guarded upsert, race losers no-op), incremental
  JQL `project = KEY AND updated >= <cursor>`, upserts issues + children, advances
  the cursor. Full resync every ~10 min and on connect/board-change (catches
  deletions and column-layout changes).
- Issue ops (each = Jira call + mirror patch): create (subtask = create with
  parent), edit standard fields, delete, `GET .../transitions`, transition, comment,
  `POST .../worklogs {timeSpent, started?, comment?, adjust?}` («Log work»),
  `PUT .../worklogs/:worklogId` (started required), `DELETE .../worklogs/:worklogId`
  with the estimate adjustment as `?adjust=&value=` query parameters,
  attachment upload (multipart), attachment download (streamed proxy).
- Launch: `POST /jira/issues/:key/launch {projectId, transitionId?}` — shadow task →
  session via the existing supervisor path → transition. A failed transition never
  kills the session; it surfaces as a warning.

## UI

- **Integrations tab** (`ManagementIntegrationsPage.vue`): Jira tile becomes real.
  Not connected → owner stepper: site URL → personal token (validated live) → board
  picker. Connected → site, board, project key, connected-by, last sync; owner
  actions «Змінити дошку» / «Відключити»; per-member personal-token block (present /
  absent / replace / delete) — the place a tokenless member learns why their board
  is read-only.
- **Board switcher** on `BoardPage.vue` as decided above.
- **Jira view**: columns from `jira_columns` by `position`; cards grouped by which
  column's `status_ids` holds the issue's status. Card: key, summary, type +
  priority icons, label chips, a start–due date chip (amber today, red past due unless
  the ticket is done), assignee avatar, agent-status chip when a shadow task
  exists. Drag between columns → single-status column transitions immediately;
  multi-status column pops a status picker. Optimistic move, snap back with the Jira
  refusal text. Tokenless: drag disabled with explanatory tooltip.
- **Ticket detail dialog**: description, standard fields inline-editable for token
  holders (priority, assignee, original estimate, start & due date), time spent and
  remaining estimate shown read-only (only a worklog moves them), other custom
  fields read-only, subtasks list, attachments
  (download/upload), comments tab (composer), worklogs tab: the list, per-entry
  «Редагувати»/«Видалити» where Jira's permissions allow (the edit takes over the same
  form; the delete asks its own estimate question in place), and the «Log work» form of
  Decision 5. Actions: «Запустити», «Редагувати», «Видалити».
- **Launch dialog**: project picker (pre-selected from sidebar scope) + target
  status picker per Decision 4.
- **Merge prompt**: on a `jira_key` task hitting `merged` on this machine —
  status-picker dialog, skippable.
- **Create ticket**: «+ Тікет» in the Jira view header → summary, description, type,
  priority, labels, assignee, start & due date, parent.

## Failure handling

- **401** → token marked invalid locally; UI drops to read-only, points to the
  Integrations tab. No retry loop.
- **429/5xx** → exponential backoff on the poller; user actions fail fast with
  mapped, human, Ukrainian error text (the `ASSIGNMENT_REFUSALS` pattern).
- **Stale transition** → snap card back, resync that issue, toast «Тікет уже
  перенесено в Jira — дошку оновлено».
- **Issue deleted while its shadow task runs** → session untouched; card disappears;
  shadow task lives to terminal, then orphans normally.
- **Offline** → the native board's existing degradation: last mirror state, actions
  disabled.

## Testing

- Pure mapping modules + unit tests: Jira payload → mirror rows, status→column
  grouping, transition-target selection, launch preselection rules.
- `JiraClient` against a mocked HTTP layer (transitions, editmeta subset,
  pagination).
- RLS tests for the new tables in the existing `rls.spec.ts` local-stack pattern
  (owner-only integration row, member mirror writes, cross-workspace isolation).
- Manual end-to-end smoke against a real Jira Cloud site.

## Delivery stages

1. **Connect + mirror** — token store, connect flow, sync engine, read-only Jira
   view with detail dialog.
2. **Interact** — drag-to-transition, comments, launch flow, merge prompt.
3. **Author** — create/edit/delete, fields/labels/assignee, attachments, subtasks.
