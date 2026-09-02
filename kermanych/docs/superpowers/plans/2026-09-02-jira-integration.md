# Jira Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace Jira board mirror on «Дошка» with two-way sync and launchable tickets.

**Architecture:** All Jira HTTP flows through `apps/api` (new `JiraModule`) under per-user API tokens stored in the local registry SQLite; the mirror lives in Supabase behind member RLS and reaches every member's UI; launches create shadow rows in `tasks` (`jira_key`) and reuse the existing session pipeline unchanged.

**Tech Stack:** NestJS, better-sqlite3, Supabase (Postgres + RLS + Realtime), Quasar/Vue 3, Jira Cloud REST v3 + Agile 1.0. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-jira-integration-design.md`

## Global Constraints

- Tokens never leave the machine: registry SQLite only, never Supabase, never logs.
- Jira is the source of truth; the mirror is a cache overwritten from Jira.
- Standard fields only are editable; custom fields render read-only.
- All UI copy in Ukrainian, matching the board's existing vocabulary.
- Error mapping follows `apps/ui/src/lib/cloud-errors.ts` (`ASSIGNMENT_REFUSALS` pattern).
- Rendered Jira HTML is sanitized by our own allowlist sanitizer before `v-html`.
- Follow the additive-migration pattern in `registry.service.ts` and the RLS pattern of `20260901120000_workspace_release_notes.sql`.

---

### Task 1: Supabase migration

**Files:** Create `supabase/migrations/20260902090000_jira_integration.sql`

Tables (snake_case, all `on delete cascade` from the integration):

- `workspace_jira_integrations(id uuid pk, workspace_id uuid unique not null → workspaces, site_url text, jira_project_key text, board_id bigint, board_name text, connected_by uuid → auth.users set null, created_at, updated_at)`. Select: member. Insert/update/delete: workspace **owner** (`workspaces.owner_id = auth.uid()` via helper `is_workspace_owner` — add the helper if absent, mirroring `is_workspace_member`).
- `jira_sync_state(integration_id uuid pk → workspace_jira_integrations, last_synced_at timestamptz, sync_cursor timestamptz)`. Member select/insert/update (the lease writer is any member's api).
- `jira_columns(integration_id, position int, name text, status_ids text[], pk (integration_id, position))`. Member select; member insert/update/delete (written by sync).
- `jira_issues(integration_id, issue_id text, key text, summary text, description_html text, type_name text, type_icon text, priority_name text, priority_icon text, labels text[], assignee_account_id text, assignee_name text, assignee_avatar text, reporter_name text, status_id text, status_name text, status_category text, parent_key text, jira_updated_at timestamptz, kermanych_project_id uuid → projects set null, task_id uuid → tasks set null, updated_at, pk (integration_id, issue_id))`. Member all ops. **Added to `supabase_realtime` publication.**
- `jira_comments(integration_id, issue_id, comment_id text, author_name text, author_avatar text, body_html text, jira_created_at timestamptz, jira_updated_at timestamptz, pk (integration_id, comment_id))`, `jira_worklogs(… worklog_id, author_name, author_avatar, time_spent text, seconds int, started_at, comment_html, pk (integration_id, worklog_id))`, `jira_attachments(… attachment_id, issue_id, filename, mime, size bigint, author_name, jira_created_at, pk (integration_id, attachment_id))`. Member all ops, no realtime.
- `alter table tasks add column if not exists jira_key text;` (covered by existing row-level policies, per the `task_effort` precedent).

Member policies via `public.is_workspace_member(workspace_id_of(integration_id), auth.uid())` — since child tables carry only `integration_id`, each gets a `workspace_id uuid not null` denormalized column instead of a subquery, filled by the api on upsert (same denormalization reasoning as `workspace_risk_events.workspace_id`).

Steps: write SQL → `supabase start` + apply locally if Docker available, else validated by RLS spec in Task 12 → commit.

### Task 2: Cloud package mirror module

**Files:** Create `packages/cloud/src/jira.ts`; modify `packages/cloud/src/index.ts`, `packages/cloud/src/types.ts`
**Produces:**
- Types `JiraIntegration, JiraSyncState, JiraColumn, JiraIssue, JiraComment, JiraWorklog, JiraAttachment` (camelCase mirrors of Task 1 rows).
- Reads for the UI: `getJiraIntegration(client, workspaceId)`, `listJiraColumns(client, integrationId)`, `listJiraIssues(client, integrationId)`, `listJiraIssueChildren(client, integrationId, issueId)` → `{comments, worklogs, attachments}`.
- Writes for the api's sync: `upsertJiraIntegration`, `deleteJiraIntegration`, `replaceJiraColumns`, `upsertJiraIssues(client, rows)`, `deleteJiraIssues(client, integrationId, issueIds)`, `replaceJiraIssueChildren`, `takeSyncLease(client, integrationId, staleMs)` (guarded update returning boolean), `advanceSyncCursor`.
- `subscribeJiraIssues(client, integrationId, onEvent)` following `subscribeTasks`.
- Row↔type mappers exported for tests (`toJiraIssueRow`, `fromJiraIssueRow`).

Steps: types + mappers → unit tests in `packages/cloud/test/jira.spec.ts` (mapper round-trip, lease query shape via the existing `fakeClient` helper) → run `vitest` in `packages/cloud` → commit.

### Task 3: Local token store

**Files:** Modify `apps/api/src/registry/registry.service.ts`
**Produces:** `CREATE TABLE IF NOT EXISTS jira_tokens (site_url TEXT, user_id TEXT, email TEXT, api_token TEXT, PRIMARY KEY (site_url, user_id))`; methods `getJiraToken(siteUrl, userId): {email, apiToken} | undefined`, `setJiraToken(siteUrl, userId, email, apiToken)`, `deleteJiraToken(siteUrl, userId)`, `listJiraTokenSites(userId): string[]`.

Steps: schema + methods following existing prepared-statement style → commit (registry has no dedicated spec file; behavior covered by Task 6's service tests).

### Task 4: Jira REST client

**Files:** Create `apps/api/src/jira/jira-client.ts`, `apps/api/src/jira/jira-client.spec.ts`
**Produces:** `class JiraClient` constructed with `{siteUrl, email, apiToken}`; `fetch`-based, Basic auth, JSON; throws `JiraHttpError{status, message}` with Jira's `errorMessages` flattened. Methods:
`myself()`, `listBoards(projectKeyOrName?)` (paginated `/rest/agile/1.0/board`), `boardConfiguration(boardId)` (columns + statuses), `boardLocationProjectKey(boardId)`, `searchIssues(jql, {fields, expand: 'renderedFields', pagination})`, `getIssue(key)`, `listTransitions(key)`, `transition(key, transitionId)`, `addComment(key, bodyText)`, `createIssue(fields)`, `editIssue(key, fields)`, `deleteIssue(key)`, `listComments/ listWorklogs (via getIssue expand)`, `uploadAttachment(key, filename, buffer, mime)` (multipart, `X-Atlassian-Token: no-check`), `downloadAttachment(attachmentId)` (returns stream + headers), `projectStatuses(projectKey)`, `editMeta(key)`.

Steps: failing tests with a mocked global fetch (auth header shape, pagination loop, error flattening) → implement → tests pass → commit.

### Task 5: Mapping module

**Files:** Create `apps/api/src/jira/jira-map.ts`, `apps/api/src/jira/jira-map.spec.ts`
**Produces:** pure functions `mapBoardColumns(config): JiraColumn[]`, `mapIssue(integration, raw): JiraIssue` (renderedFields description, status category key, parent, icons), `mapComments/mapWorklogs/mapAttachments`, `pickInProgressTransition(transitions)` (first with `to.statusCategory.key === 'indeterminate'`), `columnForStatus(columns, statusId)`.

Steps: failing tests from captured real-shape fixtures → implement → pass → commit.

### Task 6: Jira service + sync engine + controller

**Files:** Create `apps/api/src/jira/jira.service.ts`, `apps/api/src/http/jira.controller.ts`; modify `apps/api/src/app.module.ts`
**Consumes:** Tasks 2–5; `AuthService.cloudClient()`, `AuthService.current()`.
**Produces (HTTP, guarded):**
- `GET /jira/token?site=` → `{present, email}` | `PUT /jira/token {siteUrl,email,token}` (validates via `myself()`, 401 → refusal) | `DELETE /jira/token?site=`
- `GET /jira/boards?site=` → `[{id,name,projectKey}]`
- `POST /jira/integrations {workspaceId, siteUrl, boardId}` → writes integration + columns + full sync
- `DELETE /jira/integrations/:workspaceId`
- `POST /jira/sync/:workspaceId {full?}` → `{synced: boolean}`; lease via `takeSyncLease` (25 s stale), incremental JQL `project = K AND updated >= cursor` ordered by updated, upsert issues + children of changed issues; `full` sweep also reconciles deletions and columns (every 10th sync or on demand)
- `GET /jira/issues/:workspaceId/:key/transitions`, `POST .../transition {transitionId}`, `POST .../comments {body}` — each: Jira call then mirror patch
- `POST /jira/issues/:workspaceId` create, `PATCH .../:key` edit standard fields, `DELETE .../:key`
- `POST .../:key/attachments` (multipart), `GET .../:key/attachments/:attachmentId` (stream proxy)
- `POST /jira/issues/:workspaceId/:key/launch {projectId, transitionId?, images?}` → insert shadow task (`createTask` + `jira_key`, assignee = caller, model/effort from project defaults) → `supervisor.createSessionFromTask` → optional transition (failure → `{session, transitionError}`)

Steps: service tests with mocked JiraClient + fake cloud client (lease respected; deletion reconciliation; launch order: task → session → transition; transition failure non-fatal) → implement → pass → wire module → commit.

### Task 7: UI api surface + store

**Files:** Modify `apps/ui/src/lib/api.ts`, `apps/ui/src/lib/cloud-errors.ts`; create `apps/ui/src/stores/jira.ts`, `apps/ui/src/lib/jira-view.ts`, `apps/ui/src/lib/sanitize-html.ts` (+ specs for the two lib modules)
**Produces:** typed api wrappers for every Task 6 endpoint; Pinia store `useJira` holding `integration`, `columns`, `issues`, per-issue children cache, `tokenPresent`, `syncing`; `load(workspaceId)`, realtime subscription, 30 s sync ticker while the view is open. `jira-view.ts`: pure grouping `issuesByColumn(columns, issues)`, drag decision `transitionChoiceForDrop(column, transitions)`, launch preselection `launchDefaults(issue, sidebarProjectId, projects, statuses)` (In-Progress hidden-picker rule). `sanitize-html.ts`: allowlist tag/attr sanitizer for Jira rendered HTML.

Steps: failing specs for `jira-view.ts` + `sanitize-html.ts` → implement → pass → commit.

### Task 8: Integrations tab flow

**Files:** Modify `apps/ui/src/pages/ManagementIntegrationsPage.vue`
Jira tile becomes stateful: not-connected owner stepper (site → personal token → board picker), connected summary (site, board, project key, connected-by, last sync) + owner actions «Змінити дошку»/«Відключити» + per-member token block. Non-owner without integration sees «Підключає власник воркспейсу».

Steps: implement → smoke via dev app → commit.

### Task 9: Jira board view (read-only) + switcher

**Files:** Modify `apps/ui/src/pages/BoardPage.vue`; create `apps/ui/src/components/jira/JiraBoardView.vue`, `JiraCard.vue`, `JiraTicketDialog.vue`
Switcher «Задачі | Jira» appears only with an active integration; native list filters `jira_key == null`. Jira view renders `jira_columns` and grouped cards (key, summary, type/priority icons, label chips, assignee avatar, agent chip via `task_id` join). Dialog: description (sanitized), fields read-only, subtasks (by `parent_key`), comments, worklogs, attachments list with download.

Steps: implement → visual smoke (dev app, browser) → commit.

### Task 10: Interactions (Stage 2)

**Files:** Modify `JiraBoardView.vue`, `JiraTicketDialog.vue`, `stores/jira.ts`; create `apps/ui/src/components/jira/JiraLaunchDialog.vue`, `JiraStatusPickDialog.vue`
- Drag → single-status column: immediate transition (optimistic + snap-back with mapped refusal); multi-status: `JiraStatusPickDialog`.
- Comment composer posts and refreshes children.
- «Запустити» → `JiraLaunchDialog` (project pre-selected from sidebar scope; status picker hidden when `status_category === 'indeterminate'`) → launch endpoint → agent chip appears.
- Merge prompt: watch local store for `jira_key` tasks entering `merged` on this machine → `JiraStatusPickDialog` (skippable).

Steps: implement per sub-feature → smoke each in dev app → commit each.

### Task 11: Authoring (Stage 3)

**Files:** Modify `JiraTicketDialog.vue`, `JiraBoardView.vue`; create `apps/ui/src/components/jira/JiraIssueEditor.vue`
«+ Тікет» / «Редагувати» editor (summary, description, type, priority, labels, assignee from Jira assignable users, parent for subtask), delete with confirm, attachment upload button, inline label/assignee edits.

Steps: implement → smoke → commit.

### Task 12: Verification

- `packages/cloud/test/rls.spec.ts` additions: member reads mirror, non-member blocked, owner-only integration row, member lease update.
- Full unit runs in touched packages; `pnpm -r test` at the end only.
- Manual end-to-end smoke against a real Jira Cloud site (connect → mirror → drag → comment → launch → merge prompt → author).
