# Remove Routines (scheduled tasks)

- **Date:** 2026-10-19
- **Branch:** `fix/routine-feature-remove`

## Goal

The operator asked to remove the Routines feature completely: it does not work the way they want.
The application should return to its state before Routines existed.

## Context

Routines were added in PR #161 (`feature/scheduled-tasks`, merge `fcdf2de`, 2026-10-16) and changed in PR #162
(`fix/please-review-errors-with-routines`, `70b92a8`):

- **PR #161:** the «Routines» Менеджмент section, with its page, editor, detail and cloud dialog,
  store, `lib/routines.ts`, i18n, icon, route and the `routine_run` socket event. It also added:
  - the api `RoutinesService` and `RoutinesController`;
  - `packages/core` (`routines.ts`, `routine-schedule.ts`, `routine-report-prompt.ts`; `release-notes-prompt.ts`
    moved into core);
  - `packages/cloud` (`routines.ts`, `edge.ts`);
  - the `routines-runner` Edge Function;
  - migrations `20261017090000_workspace_routines.sql` and `20261017100000_routines_cloud_runner.sql`.
- **PR #162:** a Slack fix (renewing rotating user tokens) and Routines-only changes:
  - `SlackReleaseNotesService.postToChannel` and its «connect again» message;
  - the routine editor's channel error;
  - the README «cloud runner» deploy steps.

Both migrations have been applied to the hosted project, where `workspace_routines`,
`workspace_routine_runs` and `workspace_routine_cloud` exist. The `routines-runner` function was
never deployed: `POST /functions/v1/routines-runner` answers 404 `NOT_FOUND`.

## Decisions

- **Revert PR #161 as a whole** (`git revert -m 1 fcdf2de`). This also undoes the refactors that
  came with it:
  - `release-notes-prompt.ts` moves back to `apps/api/src/management/`;
  - `edge.ts` is folded back into `doc-rag.ts`;
  - the CORS comment is restored;
  - `ReleaseNotesService.generateScheduled` is removed.

  Their only purpose was Routines, and the goal is the state before the feature.
- **Keep the Slack token renewal from PR #162.** Release notes sent to Slack, which existed before
  Routines, use the same user token. Without the renewal, «Send to Slack» stops working 12 hours
  after a member connects. The changes it keeps:
  - `refresh_token` and `expires_at` in `slack_user_tokens`;
  - `SlackClient.oauthUserRefresh`;
  - `SlackReleaseNotesService.token()`, which renews the token;
  - `invalid_refresh_token` counts as an auth error;
  - the `release-slack` store's `channels()` and `withAccount`;
  - the README paragraph on rotating tokens.

  Removed from #162: `postToChannel`, its tests and the routine editor's error line.
- **Keep the two applied migrations and add `20261019090000_drop_routines.sql`.** Deleting the
  applied migration files would make `supabase db push` fail, because the remote history would
  have versions with no local file. It would also leave the tables on the hosted project. The new
  migration:
  - unschedules `routines-cloud-tick`;
  - drops `routines_cloud_tick()`, the three tables and their touch functions;
  - deletes the two `routines_*` Vault secrets;
  - restores `workspace_release_notes_touch()` to its 20261012090000 body.

  `pg_cron` and `pg_net` stay installed. Removing an extension is outside this change, and with no
  job, `pg_cron` does nothing.

## Changes

- **UI:** removed the Routines page, its components and store, `lib/routines.ts`, the tests, the
  `routines` icon, the route, the section icon, the `routine_run` toast and notification in
  `orchestrator.ts`, `api.runRoutine` and every `management.routines.*` i18n key (uk, en).
  `SlackAccountStatus` no longer carries `teamId`.
- **API:** removed `RoutinesService` and `RoutinesController`. `EventsGateway` no longer forwards
  routine events. `SlackReleaseNotesService.postToChannel` is gone.
- **Core:** removed the routines vocabulary, schedule math, report prompt, the
  `management-routines` section and the `routine_run` server event.
- **Cloud:** removed the routines module and its exports. `edge.ts` is folded back into
  `doc-rag.ts`.
- **Supabase:**
  - removed the `routines-runner` function, its `config.toml` block and its `.env.example`
    entries;
  - added the drop migration.
- **Docs:** removed `docs/specs/2026-10-16-routines.md` and the README «Routines» and «The cloud
  runner» sections. Added a README note on the drop migration.

## Verification

- `pnpm --filter @kermanych/core --filter @kermanych/cloud test`: core 211 passed; cloud 158 passed
  and 65 skipped (the RLS suite needs a local stack).
- `apps/api` `vitest run`: 933 passed. 2 failed in `rpc-session.compact.spec.ts`; PR #161 recorded
  the same failure on its base.
- `apps/ui` `vitest run`: 616 passed. 1 failed, `assignments.spec.ts` (byte warning, 8359 vs 8192);
  it fails identically on `dev` without this change.
- `apps/api tsc --noEmit`: only the existing `jira.controller.ts:350` error. `apps/ui vue-tsc
  --noEmit`: only the existing `runtime-messages.spec.ts` error.
- Preview (`KERMANYCH_PREVIEW=1` api and ui): the api boots without `RoutinesService`. Менеджмент
  lists Home, Storage, Project Documentation, Risk Registry, Release Notes, Team Capacity and
  Integrations, with no «Routines» text anywhere and no page errors.
- Migration, checked on a throwaway Postgres 16 with stub `auth`, `vault` and `cron` schemas:
  - both routine migrations, then the drop. Result: no `%routine%` relation or function is left,
    only the two routine Vault secrets and the routine cron job are removed, and
    `workspace_release_notes_touch()` is back to stamping `auth.uid()`;
  - re-applying the drop is a no-op;
  - the drop also applies with no `vault` or `cron` schema.

## Documentation impact

`kermanych/README.md`:

- removed «Routines (scheduled tasks)» and «The cloud runner»;
- added a paragraph on `20261019090000_drop_routines.sql` under «Applying a migration to the
  team's project».

Removed `docs/specs/2026-10-16-routines.md`.
