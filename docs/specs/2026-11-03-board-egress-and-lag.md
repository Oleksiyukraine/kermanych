# Board sync: Supabase egress and UI lag

- **Date:** 2026-11-03
- **Branch:** `feature/reduce-supabase-egress-usage`
- **Scope:** `packages/cloud` (task reads, Realtime binding, status mapping), `apps/ui` (board
  store, card dialog, «Агенти», Jira/Linear merge prompts), `apps/api` (status push).

## Goal

The hosted project (Free plan) used 11.4 GB of egress in a 5 GB cycle, and the grace period
ends on 29 Nov 2026. After that requests get `402`. 89.5% of the egress is PostgREST and 10.3%
is Realtime. The operator also asked whether the same sync makes Kermanych lag. It does.

## Context

Measured on the hosted project (`pg_stat_statements` since 2026-08-21, read-only):

- The board's `listTasks` (`select` of every column, every project, closed cards included) ran
  ~49 000 times. One answer is 0.5–1 MB of JSON per workspace: 620 rows, of which `qa_checklist`
  (192–396 kB) and `docs_report` (29–251 kB) are the heaviest columns.
- Its caller is the board store's reconcile (`installReconcile(() => load())`, every 60 s while
  the window is visible). `MainLayout` subscribes the board for the whole app life, not only on
  «Дошка».
- `pushTaskStatus` ran 145 579 times: `taskStatusFromSession` was the identity map, so every
  `thinking` ↔ `tool` flip of every agent went to the cloud. Each push reaches every subscribed
  client through Realtime as the whole row.

The lag, measured with this repo's Vue on 620 synthetic rows (2.2 MB):

| | median |
|---|---|
| `JSON.parse` of the list | 1.4 ms |
| one Realtime upsert, no watchers | 0.2 ms |
| one Realtime upsert with the two `deep: true` watchers | 54 ms |
| the minute reconcile (parse + replace + deep watchers) | 100 ms |

`JiraMergePrompt` and `LinearMergePrompt` (both mounted in `MainLayout`) watched `board.tasks`
with `deep: true`. Every upsert walked every field of every card on the main thread.

## Decisions

1. **Shallow watchers in the merge prompts.** Every store write replaces the `tasks` array, so a
   shallow watch fires on each change. They read `id`, `status` and `jiraKey`/`linearKey` only.
2. **Delta reconcile.** The reconcile reads `id, updated_at` of the board's projects (~40 kB
   instead of ~1 MB), refetches only rows whose `updated_at` moved or that are new, and drops ids
   the cloud no longer returns. `updated_at` is server-owned (`tasks_guard` sets `now()` on every
   update), so the comparison does not depend on a machine clock. Only the first read after
   sign-in is a full list. Rejected: `updated_at > watermark`, because it cannot see deletes
   (the filtered Realtime binding never carries DELETE, which is why the reconcile exists).
3. **The two report blobs leave the list.** `listTasks`, the delta refetch and the Realtime
   binding (its `select` option) carry every column except `qa_checklist` and `docs_report`.
   `session_report` stays: the minion marks on every card read it. A screen that shows the blobs
   holds the card (`board.holdDetails(id)`). The store then reads the full row once and again
   whenever a lighter row with a newer `updated_at` arrives for it. A light row keeps the blobs
   the store already holds, so an open card does not flicker.
4. **Coarse status.** `taskStatusFromSession` maps `tool` to `thinking`: both are the board's
   «В роботі». Every `tool` row already stored keeps working, because the board still reads
   `tool` as running. The push was also the stale hint's implicit heartbeat («Немає оновлень»
   after 90 s on a self-driving card). `CloudSyncService` now re-pushes an unchanged
   self-driving status once `TASK_STATUS_KEEPALIVE_MS` (45 s) have passed. The supervisor emits
   a `session_update` every 2 s while a turn runs, long tool calls included, so a live card
   stays fresh and a dead machine still goes stale after 90 s.
5. **A refused binding reads as offline.** The hosted Realtime accepts `select` and validates
   each column against the subscriber's privileges. It answers the join with SUBSCRIBED and then
   reports a refusal only in a `system` message, after which the channel delivers nothing.
   Checked on the hosted project: an anon join with `select` got `invalid column for select id`,
   while `authenticated` holds SELECT on every `tasks` column (`has_column_privilege`).
   `subscribeTasks` maps that system error to CHANNEL_ERROR, so the board shows «немає звʼязку»
   instead of going quietly stale.

## Changes

- `packages/cloud/src/tasks.ts`: `TASK_LIST_COLUMNS` (no `qa_checklist`, `docs_report`);
  `listTasks` uses it; new `listTaskVersions`, `listTasksByIds` (chunks of 100 ids);
  `subscribeTasks` passes `select` to Realtime and reports a refused binding.
- `packages/cloud/src/status.ts`: `taskStatusFromSession` collapses `tool`;
  `SELF_DRIVING_TASK_STATUSES`, `TASK_STATUS_KEEPALIVE_MS`.
- `apps/api/src/cloud/cloud-sync.service.ts`: keepalive re-push.
- `apps/ui/src/stores/board.ts`: delta `load()`, `holdDetails`, `detailsLoaded`, merge rules.
- `apps/ui/src/composables/useTaskDetails.ts`: holds the card for the lifetime of a screen.
- `apps/ui/src/pages/BoardPage.vue`, `AgentsPage.vue`: hold the opened / linked card;
  `BoardPage` takes the self-driving list from cloud.
- `apps/ui/src/components/jira/JiraMergePrompt.vue`, `linear/LinearMergePrompt.vue`: shallow
  watch.

## Verification

- Hosted data, per workspace (bytes of the JSON rows): full list 1017 / 888 / 488 kB, light list
  459 / 444 / 263 kB, versions read 19 / 29 / 11 kB. A quiet minute's reconcile costs about 2–3%
  of what it did.
- Benchmark of the real store (throwaway vitest, 620 rows, both merge-prompt watchers): one
  Realtime upsert 0.54 ms median (was 54 ms), a quiet reconcile 0.29 ms (was ~100 ms), with no
  array write.
- `packages/cloud`: `vitest run` — 175 passed (RLS suites skipped: no local stack, Docker is
  not running). New: versions read, by-id chunking at 100/100/1, list vs full columns, the
  Realtime `select`, the refused-binding state.
- `apps/api`: `tsc --noEmit` clean; `vitest run` — 1199 passed. New: the keepalive re-pushes a
  running status at 45 s and never a `waiting_input`.
- `apps/ui`: `vue-tsc --noEmit` clean; `vitest run` — 829 passed. New `test/board-sync.spec.ts`:
  a quiet reconcile writes nothing; moved/new cards are refetched and deleted ones dropped; a
  card Realtime delivered during the versions read survives; an older read never replaces a
  newer row; a held card keeps its checklist across a light row and re-reads it; a card held
  before it arrives is read on arrival.
- Live preview (no cloud): «Агенти» with a session selected, its QA tab, and «Дошка» render
  with no console errors.
- Not verified against the hosted project with a signed-in user: the Realtime `select` join and
  payloads, and the egress curve after the release. Watch Usage → Egress for the days after
  the update ships to the team.

## Documentation impact

- `kermanych/README.md`, «Cloud tasks and local sessions» → «Status flows back»: the coarse
  status, the keepalive, what Realtime and the list carry, the reconcile.
- Same file, «Offline behaviour» and «A task stuck «in progress»»: the stale hint and the
  keepalive.
