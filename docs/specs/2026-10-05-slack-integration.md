# Slack integration — documentation Q&A bot per workspace

## Goal

Turn the presentation-only Slack tile in **Менеджмент → Integrations** into a live
integration: a Slack app (bot) sits in one Slack channel bound to one Kermanych workspace
and answers questions about that workspace's project documentation.

- A top-level message in the bound channel is a question. Kermanych replies **in a thread**
  under it, grounded in the workspace's indexed project documentation.
- When the documentation does not describe what was asked, the reply says
  «We do not have such feature built yet.»
- Inside a thread, Kermanych answers a follow-up **only when @-mentioned**, using the whole
  thread (root question, earlier answers, the discussion) plus the documentation as context.
- Scope is one workspace: the bot never reads another workspace's documentation.

## Context

- The NestJS API is local (`127.0.0.1:4317`, hosted in-process by Electron). Nothing on the
  public internet can reach it, so Slack's HTTP Events API cannot target it.
- Supabase is the shared cloud; every cloud call runs under the signed-in user's JWT and RLS.
  There is no service-role key anywhere, and `project_doc_chunks` must never be read with one
  (`20260911090000_project_doc_rag.sql`).
- Documentation search already exists: `searchProjectDocs` → Edge Function `docs-rag` →
  `match_project_doc_chunks` (hybrid vector + full-text), one project per call
  (`packages/cloud/src/doc-rag.ts`).
- LLM calls are agent-runtime children (`createRuntime`, omp or Claude Code) billed to the
  operator's plan; `ReleaseNotesService.oneShot` was the one-prompt/one-answer pattern.
- Jira/Linear integrations: a per-workspace cloud row (member read, owner write, no secrets)
  plus personal tokens in the machine's SQLite registry.

## Decisions

- **Socket Mode from the local API**, not an Events API webhook. Socket Mode is an outbound
  WebSocket, so the local API can receive events. Rejected: a Supabase Edge Function
  webhook — it would need the service role to read documentation without a user JWT (the
  exact leak the RAG migration forbids) and an LLM key in the cloud, which does not exist.
  Consequence: the bot answers only while a member who holds the Slack tokens has
  Kermanych open and signed in.
- **Tokens are local, keyed by Kermanych workspace** (`slack_tokens(workspace_id, user_id, …)`
  in the registry SQLite), the same custody rule as Jira/Linear. The cloud row holds only
  Slack team/channel identifiers. Any member may store the same tokens on their machine to
  host the bot too; Slack spreads events across a single app's open connections, so each
  question is answered once.
- **One Slack app per Kermanych workspace.** Two workspaces sharing one app would split its
  events across machines that cannot see each other's workspace. Creating an app from the
  manifest the UI copies takes a minute.
- **One channel per workspace.** Messages in other channels the bot was invited to are
  ignored.
- **Every top-level message in the channel is a question; thread replies need a mention.**
  Events used: `message.channels`, `message.groups`. Bot, edited, and system messages are
  ignored.
- **Retrieval is the existing RAG, under the operator's JWT**, across every project of the
  workspace that has an index. No index anywhere → a fixed reply saying the documentation is
  not indexed, without spending an LLM call.
- **The answer is a tool-less one-shot** (`runtime/one-shot.ts`, extracted from release
  notes and shared by both): answer only from the fragments, like the docs section of the
  management chat. Questions are answered one at a time; a placeholder reply is posted at
  once and edited into the answer.
- **No Slack SDK.** Web API calls are a small `fetch` client and Socket Mode is Node's global
  `WebSocket`, matching the hand-written Jira/Linear clients.

## Changes

- **Cloud:** migration `20261005090000_slack_integration.sql` —
  `workspace_slack_integrations` (unique `workspace_id`, unique `(team_id, channel_id)`),
  member select, owner insert/update/delete, touch trigger. `packages/cloud`:
  `SlackIntegration` type, `getSlackIntegration`, `upsertSlackIntegration`,
  `deleteSlackIntegration`.
- **API:** `apps/api/src/slack/` — `slack-client.ts` (Web API), `slack-socket.ts` (Socket
  Mode), `slack-map.ts` (message classification, transcript, mrkdwn), `slack-prompt.ts`,
  `slack.service.ts` (token custody, sockets, answering). `http/slack.controller.ts`:
  `GET|PUT|DELETE /slack/token`, `GET /slack/channels`, `POST /slack/integrations`,
  `DELETE /slack/integrations/:workspaceId`. Registry table `slack_tokens`.
  `AuthService.onClear` so sign-out closes the sockets. `runtime/one-shot.ts` replaces
  `ReleaseNotesService.oneShot`.
- **UI:** the Slack tile gets connect (app manifest + tokens → channel) and settings (facts,
  this machine's tokens and listening state, owner change-channel/disconnect) modals;
  `slack.*` i18n in en/uk.
- **Docs:** README `### Slack`.

## Verification

- `pnpm --filter @kermanych/api typecheck` — passes.
- `pnpm --filter @kermanych/api test` — the new `test/slack-map.spec.ts` (message
  classification, thread transcript, mrkdwn conversion, Socket Mode ack-before-handle,
  event-id dedupe, reconnect/stop) and the release-notes/management-runtime specs that drive
  the extracted `runOneShot` pass. The only failures are the two in
  `test/rpc-session.compact.spec.ts`; they are in `rpc-session.ts`, which this change does
  not touch.
- `pnpm --filter @kermanych/ui test` (47 files), `@kermanych/core test`,
  `@kermanych/cloud test` — pass. `@kermanych/ui typecheck` reports one error, in
  `test/runtime-messages.spec.ts:13`, which this change does not touch either.
- End-to-end smoke (throwaway, deleted): a real `SlackService` with the real `SlackClient`
  against a local fake Web API, the real `SlackSocket` (Node's global `WebSocket`) against
  a local Socket Mode server, cloud reads mocked, and a **real omp** answer. Results:
  - Noise was ignored: a message in another channel, an untagged thread reply and the
    bot's own post.
  - A retried envelope was answered once.
  - «How does the P&L feature work?» got a placeholder in the thread, edited into an
    answer that cites `ledger › docs/schemas/pnl.md`.
  - «Do we support SSO login through Okta?» got «We do not have such feature built yet.»
  - A tagged follow-up in the thread was answered from the thread plus the documentation.
    It corrected a teammate's wrong claim made earlier in the thread.
  - Only the bound workspace's project was searched.
- UI: preview api and dev server in a headless browser. Checked the Slack tile, the
  connect modal (manifest steps and token fields), the channel step and the settings card.
  Submitting fake tokens made a real call to Slack and showed «slack token invalid» from
  `invalid_auth`.

## Documentation impact

- `kermanych/README.md` — new `### Slack` section: Slack app setup (manifest, scopes,
  tokens), the question/follow-up behaviour, the online-host requirement, token custody,
  one app per workspace, and the migration to push.
- `packages/core/src/management.ts` and the UI's `management.sections` i18n — the
  Integrations section's limitation no longer claims nothing is connected.
