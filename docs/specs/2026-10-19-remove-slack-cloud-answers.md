# Remove Slack cloud answers

- **Date:** 2026-10-19
- **Branch:** `fix/slack-cloud-functionality-removal`

## Goal

The operator asked to remove the Slack «Cloud answers» (Відповіді з хмари) completely. Kermanych no
longer sends messages from the cloud, so a cloud host for the Slack documentation bot must not
exist. The desktop bot and the rest of the Slack integration must keep working.

## Context

Cloud answers were added in PR #159 (`feature/api-doc-answers-in-slack`, merge `3f5fb5d`,
2026-10-16). Its only content commit is `d8421de`; its merge `156abbf` brought in dev without
conflicts. It added:

- the `slack-events` Edge Function, its `config.toml` block and `.env.example` mention;
- migration `20261016090000_slack_cloud_answers.sql`: tables `workspace_slack_cloud` and
  `slack_cloud_events`, and seven `*slack_cloud*` functions;
- the «Cloud answers» section of the Slack card in `ManagementIntegrationsPage.vue`, its i18n
  (uk, en), `api.slackSetCloud` / `api.slackDeleteCloud`, and `slackCloudManifest` /
  `slackCloudRequestUrl` in `lib/slack-manifest.ts`;
- `PUT`/`DELETE /slack/cloud` in `slack.controller.ts`, and the stand-down of the desktop socket
  while cloud mode was on in `slack.service.ts`;
- `getSlackCloudStatus` / `setSlackCloud` / `deleteSlackCloud` and the `SlackCloud*` types in
  `packages/cloud`.

It also made two refactors, only so the Deno function could share code:

- the answer pipeline moved from `apps/api/src/slack/slack-map.ts` and `slack-prompt.ts` into
  `packages/core/src/slack-answer.ts`;
- the Voyage helper moved out of `docs-rag/index.ts` into `functions/_shared/voyage.ts`.

The migration is applied on the hosted project, and a workspace there has cloud answers set
up.

## Decisions

- **Revert PR #159 as a whole** (`git revert d8421de`), the refactors included. The answer
  pipeline goes back to `apps/api/src/slack/` and the Voyage helper back into `docs-rag`. Their
  only purpose was the cloud host, and the goal is the state before the feature. No commit after
  #159 touched these files, so `slack.service.ts`, `slack-map.ts`, `slack-prompt.ts`,
  `slack.controller.ts`, `ManagementIntegrationsPage.vue`, `packages/cloud/src/slack.ts`,
  `slack-map.spec.ts` and `docs-rag/` are byte-identical to their pre-#159 versions.
- **Keep later work in the files #159 shared with others.** That means the rotating-token
  comment in `slack-manifest.ts` (PR #162) and `AgentRuntimeKind` in the `packages/cloud`
  types import (PR #165). Those two were the only conflicts.
- **Keep the applied migration and add `20261019100000_drop_slack_cloud_answers.sql`.** The
  routines removal set this pattern: deleting an applied migration file makes `supabase db push`
  fail, and it would leave the secrets on the hosted project. The new migration drops the seven
  functions, then `slack_cloud_events`, then `workspace_slack_cloud`. That deletes every stored
  Slack bot token, signing secret and AI key. `workspace_slack_integrations` (the desktop bot's
  channel binding) is untouched.

## Changes

- **UI:** removed the «Cloud answers» section of the Slack card and its status loading, the
  `slack.cloud.*` and `slack.notify.cloud*` i18n keys (uk, en), `api.slackSetCloud`,
  `api.slackDeleteCloud`, `SlackCloudSetup`, `slackCloudManifest` and `slackCloudRequestUrl`.
- **API:** removed `PUT`/`DELETE /slack/cloud` and the cloud-mode stand-down. A machine holding
  the tokens always opens its Socket Mode connection again. The answer pipeline is back in
  `slack-map.ts` / `slack-prompt.ts`, and `SlackRawMessage` is back in `slack-client.ts`.
  Removed `test/slack-cloud.spec.ts`.
- **Core:** removed `slack-answer.ts` and its exports.
- **Cloud:** removed `getSlackCloudStatus`, `setSlackCloud`, `deleteSlackCloud`,
  `SlackCloudStatus` and `SlackCloudInput`.
- **Supabase:** removed the `slack-events` function, `_shared/voyage.ts` (inlined back into
  `docs-rag`), the `config.toml` block and the `.env.example` mention. Added the drop migration.
- **Docs:** removed `docs/specs/2026-10-16-slack-cloud-answers.md`. In the README, removed the
  two-modes text, «Cloud answers» and the `slack-events` service-role exceptions, and added a
  note on the drop migration.

Operator steps on the hosted project, outside the code:

- `supabase db push --linked`;
- `supabase functions delete slack-events --project-ref uqqdudlfizfwqfegfrlh`;
- in a workspace that pasted the cloud manifest, paste the desktop manifest («Copy manifest» on
  the Slack tile) back into its Slack app. Socket Mode then turns on again and machines receive
  the questions.

## Verification

- `pnpm --filter @kermanych/core --filter @kermanych/cloud build`, then:
  - `packages/core` `vitest run`: 211 passed;
  - `packages/cloud` `vitest run`: 158 passed and 65 skipped (the RLS suite needs a local stack).
- `apps/api` `vitest run`: 931 passed, including `slack-map.spec.ts` and the Slack service
  specs. 2 failed in `rpc-session.compact.spec.ts`; that is the same failure the routines removal
  recorded on `dev`.
- `apps/ui` `vitest run`: 616 passed. 1 failed, `assignments.spec.ts` (byte warning), which also
  fails on `dev`.
- `apps/api tsc --noEmit`: only the existing `jira.controller.ts:350` error. `apps/ui vue-tsc
  --noEmit` (after `nest build` of the api): only the existing `runtime-messages.spec.ts` error.
- Preview (`KERMANYCH_PREVIEW=1` api on the built `dist`, `quasar dev` ui): Менеджмент →
  Integrations loads with no page errors. Vite serves `ManagementIntegrationsPage.vue` compiled,
  with no `slack.cloud`, `slackCloud` or `getSlackCloudStatus` reference. The Slack card itself
  needs a cloud workspace, which a cloudless preview cannot show.
- Migration, checked on a throwaway Postgres 17 with stub `auth`, workspace, project and
  `halfvec` objects:
  - `20261016090000` created 2 tables and 7 functions, and a seeded cloud row and event were
    added;
  - the drop then left no `%slack_cloud%` relation or function, and the
    `workspace_slack_integrations` row survived;
  - re-applying the drop is a no-op.

## Documentation impact

`kermanych/README.md`:

- removed the desktop/cloud modes text, «Cloud answers» and the `slack-events` exceptions in the
  secrets table and the RLS paragraph;
- added a paragraph on `20261019100000_drop_slack_cloud_answers.sql` under «Applying a migration
  to the team's project».

Removed `docs/specs/2026-10-16-slack-cloud-answers.md`.
