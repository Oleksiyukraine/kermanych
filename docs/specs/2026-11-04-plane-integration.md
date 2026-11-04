# Plane integration

## Goal

The operator asked for a Plane (plane.so) integration with the same functionality as the Jira
integration. Plane is a Jira-like tracker reached with a personal API token. Plane Cloud and
self-hosted instances must both work.

## Context

- The Jira integration (`docs/superpowers/specs/2026-09-02-jira-integration-design.md`, README
  «Jira») has these parts:
  - A Supabase mirror (`workspace_jira_integrations`, `jira_sync_state`, `jira_columns`,
    `jira_issues`, `jira_comments`, `jira_worklogs`, `jira_attachments`, `tasks.jira_key`).
    The data access is in `packages/cloud/src/jira.ts`.
  - The api: `apps/api/src/jira/{jira-client,jira-map,jira-adf,jira.service,jira-tools.service}.ts`
    and `apps/api/src/http/jira.controller.ts`. Per-user tokens are in the registry SQLite
    (`jira_tokens`).
  - The UI: the `stores/jira.ts` store, `lib/jira-view.ts`, `components/jira/*`, the «Jira» view
    on «Дошка», the Jira tile on Менеджмент → Integrations and `JiraMergePrompt` in
    `MainLayout`.
  - Places that use Jira beyond the board:
    - the Менеджмент assistant's live `jira_*` MCP tools (`management-mcp.service.ts`,
      `management-prompt.ts`, `management-chat.service.ts`, the board context sent by
      `stores/management-chat.ts`);
    - filing a «Знахідка» as a Jira issue (`SessionFindings.vue`, `FindingTarget`);
    - Team Capacity and the Home capacity/tasks widgets (`lib/capacity.ts`,
      `lib/home-digest.ts`).
- Linear (`ed5fc196`) is the precedent for a second tracker next to Jira. It is a structural
  twin with its own tables, store, components and tile. Its tables are fully independent, so a
  workspace may connect both trackers.
- Plane API facts (full reference gathered for this task: Plane v1 docs and the
  `makeplane/plane` sources):
  - REST `/api/v1/`, header `X-API-Key`. The Cloud API host is `https://api.plane.so` and its web
    app is `https://app.plane.so`. A self-hosted instance serves both from its own origin.
  - The rate limit is **60 requests per minute per key**. A 429 response carries `Retry-After`.
  - Work items are under `/workspaces/{slug}/projects/{project_id}/work-items/`. A work item is
    also reachable by key: `/workspaces/{slug}/work-items/{IDENT}-{seq}/`. The web link is
    `{web}/{slug}/browse/{IDENT}-{seq}/`.
  - The list endpoint has no field filters. It takes `order_by=-updated_at`, `per_page≤100`,
    cursor paging (`next_cursor`, `next_page_results`) and
    `expand=assignees,labels,state,created_by,estimate_point,project,parent`. Archived, draft
    and triage items are not listed.
  - States have a `group`: `backlog | unstarted | started | completed | cancelled` (triage is
    excluded). Any state can be set: there is no workflow.
  - Priorities are the fixed enum `urgent | high | medium | low | none`. Labels are per-project
    uuids. A work item has an `assignees` uuid array, plus `start_date`, `target_date`,
    `estimate_point` (uuid), `parent` (uuid) and `type` (uuid, Pro).
  - Comments carry `comment_html` and an `actor` (`expand=actor`). Descriptions are
    `description_html`.
  - Attachments are uploaded in three steps: (1) POST the metadata to `/attachments/`, which
    returns `upload_data`; (2) a multipart POST to the presigned URL with every field and `file`
    last; (3) PATCH `{is_uploaded:true}`. A download is a GET that answers 302 to a presigned
    URL. The default size limit is 5 MB.
  - Worklogs (time tracking, Pro) live at `/work-items/{id}/worklogs/`. `duration` is in
    **minutes**, the body may carry a `description`, and there is no work-date field
    (`created_at` is the date). `/total-worklogs/` gives the per-item totals. The project field
    `is_time_tracking_enabled` turns them on. The Community edition has no worklog route (404).
  - The current user is `/users/me/`. The project members are `/projects/{id}/members/` (a plain
    array of UserLite). The project's `member_role` is `20` for admin.
  - Errors come in several shapes: `{"error": …}`, `{"detail": …}`, DRF field dicts, and
    `{"error_code", "error_message"}` for 429. An invalid key is 401 or 403.

## Decisions

1. **REST v1, not v2.** v1 runs on Plane Cloud and on self-hosted Community editions, and Plane
   keeps it working. Rejected: v2. It has nicer filters but is new and missing on older
   self-hosted instances.
2. **A connected «board» is one Plane project.** A workspace may connect up to **10** of them,
   the Jira multi-board rule. Rejected: one per workspace (Linear's rule). It is less than Jira
   offers, and Plane teams split work across projects.
3. **The token is personal and local**, the Jira/Linear custody rule. It lives in
   `plane_tokens(site_url, workspace_slug, user_id, api_token, plane_user_id, display_name)` in
   the registry SQLite. It is keyed by site **and** Plane workspace slug, because tokens may be
   workspace-scoped on some editions. The token is checked with `/users/me/` plus one projects
   read before it is stored. A member without a token gets a read-only mirror.
4. **The site URL is the web origin.** The operator types or pastes their Plane address. A
   pasted workspace URL (`https://app.plane.so/my-team/...`) fills both the site and the slug.
   `normalizePlaneSite` maps `api.plane.so` / `plane.so` / `app.plane.so` to
   `https://app.plane.so`. `planeApiBase(site)` gives `https://api.plane.so` for Cloud and the
   origin itself otherwise.
5. **Columns are the project's states**: one column per state, ordered by group
   (backlog → unstarted → started → completed → cancelled), then by `sequence`. A
   «transition» is any other state, shaped like `JiraTransition` so the pickers stay one shape.
   The status category is `backlog|unstarted → new`, `started → indeterminate` and
   `completed|cancelled → done`.
6. **Assignee is one person on the Kermanych side.** The mirror shows the first assignee. Setting
   it sends `assignees: [id]` (Jira semantics), and `null` sends `[]`. Rejected: a multi-assignee
   UI. It would fork every Jira-shaped component and the capacity maths for an edge case.
7. **Markdown in, HTML out.** Every body Kermanych writes (description, comment) is markdown
   rendered to Plane's editor HTML. `- [ ]` becomes Plane's task list
   (`<ul data-type="taskList"><li data-type="taskItem" data-checked="false">`). Plane HTML that is
   read back for editing or for a launched task is converted to markdown. Both directions live in
   `apps/api/src/plane/plane-html.ts`, which has pure functions, `markdown-it` for the outbound
   direction and no new dependency.
8. **A sync that respects 60 requests per minute.**
   - An incremental tick reads the list sorted by `-updated_at` and pages only until it reaches
     the cursor minus 60 s (usually one call). It then reads `/total-worklogs/` (one call, only
     when time tracking is on).
   - A full sweep runs on connect, on «Синхронізувати», and otherwise at most every 10 min. It
     re-reads the project and its states (the columns), lists every item, and reconciles
     deletions.
   - **Children are not fetched for every changed item in one go.**
     `plane_issues.children_synced_at` marks staleness. A child refresh is due when it is null,
     when it is older than `plane_updated_at`, or when the worklog total moved. Each tick
     refreshes children (comments, attachments, worklogs) for at most **5** items, oldest first.
     Opening the ticket dialog refreshes that one item at once.
   - A 429 during a tick ends that tick quietly with `{ synced: false, rateLimited: true }`. A 429
     on a user action surfaces as Plane's message.
9. **Worklogs are Plane's, not Jira's.**
   - There is a duration, typed in the same spelling as Jira (`3h 20m`, `45m`, `1.5h`) and
     converted to minutes by the api, and an optional description.
   - There is no «started» field and no estimate adjustment, because Plane has neither.
   - Editing and deleting follow Plane's rule: own entries are editable, and a project admin
     (`member_role` 20) may touch anyone's.
   - Without time tracking (feature off, Community edition, 404/402 on the route) the
     «Ворклоги» tab and the time fields are hidden, not broken.
10. **Estimates are estimate points.** The editor offers the project's estimate points when the
    estimates endpoint answers. Otherwise the estimate shows read-only. `originalEstimateSeconds`
    is filled only for a `time`-type estimate, whose values are read as minutes [INFERENCE: Plane
    stores time estimate values as minutes; unconfirmed in the docs]. Otherwise it is 0, so Team
    Capacity reports Plane items as unestimated rather than inventing hours.
11. **The shared field names match Jira** where the meaning is the same: `assigneeAccountId`,
    `startDate`, `dueDate`, `statusCategory`, `originalEstimateSeconds`, `timeSpentSeconds`, and
    on worklogs `authorAccountId`, `seconds` and `startedAt`. Capacity and the Home widgets can
    then read either tracker through one structural type.
12. **Labels travel by name** in drafts (Jira parity). The api resolves names to the project's
    label ids case-insensitively. It creates a missing label once, best effort; a refusal to
    create one drops that label and does not fail the write.
13. **Attachment download goes through the local api** with `redirect: "manual"`. The api reads
    `Location` and fetches it without the API key, so the key never reaches the storage host.
14. **Everything Jira has beyond the board gets a Plane twin:**
    - the launch with the merge prompt;
    - the Менеджмент assistant's `plane_*` tools on the same MCP endpoint;
    - filing a finding to Plane;
    - Team Capacity and the Home widgets with a «Jira | Plane» source switch when both are
      connected. With only one tracker connected, that one is used.
    Rejected: Plane-only shortcuts that drop the Jira-specific parts with no Plane equivalent
    (sprints → cycles, versions/components → modules). Their Plane counterparts are offered
    instead.

## Contracts

### Database: `supabase/migrations/20261104090000_plane_integration.sql`

The schema mirrors the Jira tables, the multi-board form included:

- `workspace_plane_integrations` has `id`, `workspace_id`, `site_url`, `workspace_slug`,
  `project_id` (Plane uuid, text), `project_identifier`, `project_name`, `connected_by`,
  `created_at` and `updated_at`. It is `unique (workspace_id, project_id)`. A trigger caps a
  workspace at 10 rows, a touch trigger is copied from Jira, members may select, and only the
  owner may insert, update or delete.
- `plane_sync_state` has `integration_id` (pk), `workspace_id`, `last_synced_at` and
  `sync_cursor`.
- `plane_columns` has `integration_id`, `workspace_id`, `position`, `name`, `state_ids text[]`,
  `state_group` and `color`. Its pk is `(integration_id, position)`.
- `plane_issues` has `integration_id`, `workspace_id`, `issue_id`, `key`, `summary`,
  `description_html`, `type_name`, `priority`, `labels text[]`, `estimate_point_id`,
  `estimate`, `original_estimate_seconds int`, `time_spent`, `time_spent_seconds int`,
  `start_date`, `due_date`, `assignee_account_id`, `assignee_name`, `assignee_avatar`,
  `reporter_name`, `status_id`, `status_name`, `status_category`, `parent_key`,
  `plane_updated_at timestamptz`, `children_synced_at timestamptz`, `kermanych_project_id`,
  `task_id` and `updated_at`. Its pk is `(integration_id, issue_id)`, and it is in the realtime
  publication.
- `plane_comments` has `comment_id`, `author_name`, `author_avatar`, `body_html`,
  `plane_created_at` and `plane_updated_at`.
- `plane_worklogs` has `worklog_id`, `author_account_id`, `author_name`, `author_avatar`,
  `time_spent`, `seconds`, `started_at` and `description`, with an index on
  `(integration_id, started_at)`.
- `plane_attachments` has `attachment_id`, `filename`, `mime`, `size`, `author_name` and
  `plane_created_at`.
- All children carry `integration_id`, `workspace_id` and `issue_id`, with member RLS and a
  cascade from the integration.
- `alter table public.tasks add column if not exists plane_key text;`

### `@kermanych/cloud` (`packages/cloud/src/plane.ts`, types in `types.ts`, exported from `index.ts`)

Types: `PlaneStatusCategory`, `PlaneIntegration{id, workspaceId, siteUrl, workspaceSlug,
projectId, projectIdentifier, projectName, connectedBy?, createdAt, updatedAt}`,
`PlaneIntegrationInsert`, `PlaneSyncState`, `PlaneColumn{…, stateIds, stateGroup, color}`,
`PlaneIssue`, `PlaneComment`, `PlaneWorklog`, `PlaneAttachment`, `PlaneIssueChildren`,
`PlaneIssueChange`. The `PlaneIssue` fields are the camelCase form of the columns above
(`planeUpdatedAt`, `childrenSyncedAt?`). `Task.planeKey?`, `TaskInsert.planeKey?` and
`TaskPatch.planeKey?` are added as well.

Functions (Jira names with `Plane`):

- `listPlaneIntegrations`, `getPlaneIntegrationById`, `upsertPlaneIntegration`,
  `deletePlaneIntegration`;
- `getPlaneSyncState`, `ensurePlaneSyncState`, `takePlaneSyncLease`, `advancePlaneSyncCursor`;
- `listPlaneColumns`, `replacePlaneColumns`;
- `listPlaneIssues`, `upsertPlaneIssues`, `deletePlaneIssues`, `patchPlaneIssueBinding`,
  `markPlaneChildrenSynced(client, integrationId, issueId, atIso)`;
- `listPlaneIssueChildren`, `listPlaneWorklogsBetween`, `replacePlaneIssueChildren`;
- `subscribePlaneIssues`.

`tasks.plane_key` round-trips, and every `jira_key is null and linear_key is null` filter
(native board, «Задачі» inbox, minion pick) also requires `plane_key is null`.

### Local api: `/api/plane/*` (`apps/api/src/http/plane.controller.ts`)

The acting user always comes from the guard. A Plane 401/403 auth failure becomes
`ForbiddenException("plane token invalid")`, and anything else becomes a `BadRequest` with
Plane's flattened message.

| Route | Body / query | Answer |
| --- | --- | --- |
| `GET token` | `?site&workspace` | `{present, displayName?}` |
| `PUT token` | `{siteUrl, workspaceSlug, token}` | `{displayName}` |
| `DELETE token` | `?site&workspace` | `{ok}` |
| `GET projects` | `?site&workspace` | `{id, name, identifier}[]` |
| `GET integrations/:workspaceId` | | `PlaneIntegration[]` |
| `POST integrations` | `{workspaceId, siteUrl, workspaceSlug, projectId}` | `PlaneIntegration` |
| `DELETE integrations/:integrationId` | | `{ok}` |
| `POST sync/:integrationId` | `{full?}` | `{synced, rateLimited?}` |
| `GET issues/:iid/:key/transitions` | | `PlaneTransition[]` (`{id, name, to:{id, name, statusCategory:{key}}}`) |
| `POST issues/:iid/:key/transition` | `{transitionId}` (= state id) | `PlaneIssue` |
| `POST issues/:iid/:key/comments` | `{body}` markdown | `PlaneIssue` |
| `POST issues/:iid/:key/worklogs` | `{timeSpent, description?}` | `PlaneIssue` |
| `PUT issues/:iid/:key/worklogs/:worklogId` | `{timeSpent, description?}` | `PlaneIssue` |
| `DELETE issues/:iid/:key/worklogs/:worklogId` | | `PlaneIssue` |
| `POST issues/:iid/:key/refresh` | | `PlaneIssue` |
| `POST issues/:iid` | `PlaneIssueDraft` | `PlaneIssue` |
| `PUT issues/:iid/:key` | `PlaneIssueDraft` | `PlaneIssue` |
| `GET issues/:iid/:key/description` | | `{markdown}` |
| `DELETE issues/:iid/:key` | | `{ok}` |
| `GET editor-options/:iid` | | `PlaneEditorOptions` |
| `GET assignable/:iid` | `?q` | `{accountId, displayName, avatar?}[]` |
| `POST issues/:iid/:key/attachments` | `{filename, data (base64), mimeType?}` | `PlaneIssue` |
| `GET attachments/:iid/:key/:attachmentId` | | file stream |
| `POST issues/:iid/:key/launch` | `{projectId, transitionId?, images?}` | `{session, transitionError?}` |

The shapes used in the table:

- `PlaneIssueDraft = {summary?, description? (markdown), issueTypeId?, priority?
  ('urgent'|'high'|'medium'|'low'|'none'), labels? (names), assigneeAccountId? (string|null),
  estimatePointId? (string|null), startDate?, dueDate? ('' clears), parentKey?, stateId?}`.
- `PlaneEditorOptions = {issueTypes:{id,name}[], priorities:{id,name}[] (the five, urgent
  first), labels:{id,name,color}[], states:{id,name,group,color}[],
  estimatePoints:{id,value}[], estimateType: 'points'|'categories'|'time'|'',
  timeTrackingEnabled: boolean, myAccountId: string, worklog:{editOwn, editAll, deleteOwn,
  deleteAll}}`.

### `FindingTarget`

`{ kind: "plane"; key: string; url: string }` is added beside board and Jira.
`parseFindingTarget` accepts it. `list_findings` prints `→ Plane KEY`. The constant
`FINDING_PLANE_LABEL` is not introduced: the Jira label constant `kermanych-finding` is reused.

## Changes

- **Supabase:** the new migration (see Contracts).
- **packages/cloud:** `plane.ts`, the types, the exports, and `plane_key` in `tasks.ts` plus its
  filters. Specs: `test/plane.spec.ts`, and `tasks.spec.ts` filter rows updated.
- **packages/core:** `FindingTarget` gains the plane kind. The management context gets
  `ManagementPlaneBoard` (`context.plane`), and the chat reply's `jiraChanges` becomes
  `trackerChanges` (it carries `jira_*` and `plane_*` notices). There are 16 `plane_*` notice
  codes. The Team Capacity and Integrations section texts name Plane.
- **apps/api:**
  - `plane/plane-client.ts`, `plane/plane-map.ts`, `plane/plane-html.ts`,
    `plane/plane.service.ts`, `plane/plane-tools.service.ts`, `http/plane.controller.ts`;
  - the registry `plane_tokens`, wiring in `app.module.ts`, and findings `→ Plane`;
  - `management/tracker-tools.ts` holds the shared tool kit (`ManagementToolScope`, argument
    readers, schema helpers). `JiraToolsService` now uses it with unchanged behaviour.
    `ManagementMcpService` serves `jira_*` then `plane_*` (server `kermanych-trackers`).
    `management.controller.ts` parses `context.plane`. The prompt gets a PLANE protocol, and
    the ticket rules name Plane beside Jira (the native board stays the default);
  - specs for the client, the map, the html conversion, the service and the tools.
- **apps/ui:**
  - `stores/plane.ts`, `lib/plane-view.ts`, `components/plane/*` (BoardView, Card, IssueEditor,
    LaunchDialog, MergePrompt, StatusPickDialog, TicketDialog);
  - the «Plane» tab on `BoardPage`, the Plane tile on `ManagementIntegrationsPage`,
    `PlaneMergePrompt` in `MainLayout`, and the `lib/api.ts` methods;
  - the «Plane» target in `SessionFindings`;
  - `stores/tracker.ts` + `lib/tracker-source.ts`, the «Jira | Plane» source of Team Capacity
    and the Home tiles. The Менеджмент chat's capacity and home digests read the same choice
    (`stores/management-chat.ts`), and the chat also sends `context.plane`;
  - en + uk i18n.
- **Docs:** a README «Plane» section next to «Jira».

## Verification

- **Unit suites** (each run alone, `--maxWorkers=2`):
  - `packages/cloud`: 191 passed, 72 skipped (the RLS suites need a local Supabase).
    `plane.spec.ts` and `tasks.spec.ts` pass.
  - `packages/core`: 276 passed.
  - `apps/api`: 1277 passed, 4 skipped. This includes `plane-client`, `plane-map`,
    `plane-html`, `plane.service`, `plane-tools.service`, and the updated findings,
    management-chat and management-prompt specs.
  - `apps/ui`: 899 passed. This includes `plane-view`, `plane-sync`, `tracker-source`, and the
    capacity and findings cases.
- **Typecheck:** `tsc --noEmit` (api) and `vue-tsc --noEmit` (ui) are clean. `nest build`
  succeeds.
- **Migration**, on a scratch Postgres 17 with the Supabase auth/storage/publication stubbed:
  - The whole migration chain applies. The two pgvector doc-RAG migrations were skipped
    because the scratch server has no `vector`; they are unrelated.
  - Checked as `authenticated`:
    - the owner inserts 10 projects, and the 11th is refused («at most 10 Plane projects»);
    - re-connecting the same project upserts in place;
    - a non-owner member cannot insert or update the integration row, but reads it and writes
      `plane_issues` / `plane_worklogs` / `plane_sync_state`;
    - an outsider reads nothing;
    - `connected_by` is stamped, and deleting the integration cascades the mirror;
    - `plane_issues` is in `supabase_realtime`, and `tasks.plane_key` exists.
- **HTTP layer:** a throwaway script ran `PlaneClient` against a fake Plane and a fake S3 over
  real HTTP. All of the following held:
  - the incremental list stops after one page at the cursor, and a full list pages;
  - attachment upload is three steps, with no API key sent to storage and `file` as the last
    form field;
  - download follows the 302 without the key;
  - a 429 becomes a 429 error with its retry time;
  - a 403 «token not valid» becomes 401, a label 409 resolves to the existing id, and DRF
    errors are flattened.
- **End-to-end UI:** a throwaway harness of a fake Supabase (GoTrue + an in-memory PostgREST)
  and a fake stateful Plane v1, the built api, and `quasar dev` against both, signed in.
  - Integrations → Plane tile: a pasted `…/acme/projects/` URL filled the slug, a wrong token
    was refused, and the right one led to the project picker. «Підключити» connected the
    project and ran the first sync, after which the tile showed «1 проєкт підключено».
  - «Дошка» → «Plane»: the columns were Backlog/Todo/In Progress/Done/Cancelled, and the cards
    showed keys, priority dots, labels, the date chip and assignees.
  - The ticket dialog showed the description with a task list, comments, dates, assignee and
    labels. A markdown comment with `- [x]`/`- [ ]` reached Plane as task-list HTML and read
    back with checkboxes. Logging «1h 30m» sent `duration: 90`, and «Витрачено 1h 30m»
    appeared. Moving the state to In Progress moved the card.
  - Team Capacity read the Plane project (logged 3 h).
  - The harness found one bug, fixed here: the dialog skipped its open-time loads on the first
    open, because the dialog is mounted already open. The Jira and Linear dialogs share it,
    and it was reported as a finding.

## Documentation impact

`kermanych/README.md` gains a «### Plane» section under «The shared board (cloud)», next to
«Jira». It covers the connect flow, the personal tokens, the sync cadence and its rate limit,
worklogs, the launch, and the assistant tools. The README's «Agent findings» section adds the
Plane target and its route shape. The Team Capacity paragraph and the Менеджмент assistant
paragraphs name Plane and the source switch.
