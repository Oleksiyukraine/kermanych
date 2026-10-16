# Slack documentation bot — cloud answers when nobody is online

## Goal

The Slack documentation bot (`2026-10-05-slack-integration.md`) answers only while a member
who holds the Slack tokens has Kermanych open: Slack delivers events over Socket Mode to the
local API. The ask: a second, toggleable mode in which the bot answers **with nobody
online**, using an AI API key the owner provides. The answer pattern must be the one the
desktop bot uses: same placeholder, same retrieval, same prompt, same formatting and
splitting, same follow-up rules, same «not built» and «not indexed» replies.

## Context

- The local API binds `127.0.0.1`; Slack reaches it only over Socket Mode
  (`apps/api/src/slack/slack.service.ts`, `slack-socket.ts`).
- Answering needs the documentation (`project_doc_chunks`, RLS by project membership) and a
  model. The desktop reads documentation under the member's JWT through `docs-rag` and
  generates with the member's agent runtime (`runOneShot`, `DOCS_MODEL`).
- A Slack app delivers events over Socket Mode **or** to an HTTP Request URL, never both:
  with Socket Mode enabled the Request URL is ignored. So «desktop when someone is online,
  cloud otherwise» cannot be one Slack app configuration; the mode is a switch.
- The original spec rejected an Edge Function webhook for two reasons: it needs the service
  role to read documentation without a user JWT, and an LLM key in the cloud. Cloud answers
  need both by definition; this change accepts them, opt-in, behind the narrowest surface.

## Decisions

- **Two modes, chosen by the owner per workspace.**
  - *Desktop* (default, unchanged): Socket Mode to members' machines.
  - *Cloud*: the Slack app's Request URL points at a new Edge Function `slack-events`
    (`…/functions/v1/slack-events?workspace=<id>`), which answers without any machine.
  Switching is two steps: the toggle in Kermanych, and the matching app manifest pasted into
  the Slack app (the UI copies the right one — Socket Mode off and the Request URL set for
  cloud; the existing manifest for desktop). Rejected: running both at once — Slack cannot
  deliver one app's events to both transports; a cloud relay that wakes desktops would still
  need the cloud path for the offline case and doubles the machinery.
- **One answer pipeline, two hosts.** Message classification, transcript, prompt,
  mrkdwn conversion, splitting, the placeholder/«not indexed»/apology texts and the answer
  sequence move from `apps/api/src/slack/slack-map.ts` + `slack-prompt.ts` into
  `packages/core/src/slack-answer.ts` (`answerSlackAsk`). The desktop and the Edge Function
  both call it; they differ only in how they search and how they generate. The file has
  **no imports**, so Deno imports it by relative path as is.
- **AI providers: Anthropic and any OpenAI-compatible API.** Anthropic defaults to the
  desktop's model (`claude-sonnet-5`), so a default cloud answer is the same model reading
  the same prompt. «OpenAI» takes an optional base URL, which covers OpenRouter, Groq,
  Mistral, Gemini's OpenAI endpoint and self-hosted gateways. The key is proven with a
  one-word generation before it is stored — the same «prove before storing» rule as the
  Slack tokens — which also checks the model and base URL.
- **Secrets in the cloud only for workspaces that opt in.** New table
  `workspace_slack_cloud` (bot token, Slack signing secret, provider, model, base URL, AI
  key, `enabled`), RLS on with **no policies and no grants** to `anon`/`authenticated`.
  The owner writes it through `set_slack_cloud` (security definer, owner check); members
  read a secret-free status through `get_slack_cloud_status` (key shown as its last four
  characters). The bot token is copied from the owner's machine registry by the local API;
  the owner never pastes it twice. The row references `workspace_slack_integrations` with
  `on delete cascade`, so «Disconnect» removes the cloud secrets too. Turning the switch off
  keeps the secrets (toggling back needs no re-entry); «Remove cloud keys» deletes them.
- **The service role reaches documentation only through two functions.** The Edge Function
  runs with the platform-injected service-role key, but the migration grants it no table
  privileges: it calls `slack_cloud_config`, `slack_cloud_claim_event`,
  `slack_cloud_indexed_projects` and `slack_cloud_match_docs` (security definer, execute
  granted to `service_role` only). The documentation functions return nothing unless the
  workspace's cloud mode is `enabled`, and search only projects of that workspace, through
  the existing `match_project_doc_chunks`. The workspace in the URL is trusted only after the
  request's Slack signature verifies against **that workspace's** signing secret.
- **Slack's 3-second rule.** The function verifies the signature, answers
  `url_verification` with the challenge, acknowledges an event with 200 at once and answers
  in `EdgeRuntime.waitUntil`. Duplicate deliveries are dropped by
  `slack_cloud_claim_event` (primary key on `(workspace_id, event_id)`, pruned after a day),
  the cloud counterpart of the socket's event-id set. Every verified request stamps
  `events_seen_at`, which the settings card shows as «Slack reaches the cloud».
- **Desktops stand down in cloud mode.** `SlackService` opens no socket for a workspace whose
  cloud mode is on (the Slack app would not deliver to it anyway) and reopens when it is
  turned off.
- **Retrieval in the cloud** embeds the question with the product-wide Voyage key (shared
  with `docs-rag` through `supabase/functions/_shared/voyage.ts`) and degrades to full-text
  when Voyage is unavailable — the `docs-rag` search rule.

## Changes

- **Core:** `packages/core/src/slack-answer.ts` — `classifyMessage`, `threadTranscript`,
  `toSlackMrkdwn`, `splitForSlack`, `buildSlackAnswerPrompt`, `answerSlackAsk`, the fixed
  texts, `SlackRawMessage`/`SlackAsk`/`TranscriptLine`/`SlackPromptDocs` types, and the AI
  provider call (`slackCloudGenerate`) with its defaults.
- **API:** `slack-map.ts` and `slack-prompt.ts` removed; `slack.service.ts` answers through
  `answerSlackAsk`, gains `setCloud`/`deleteCloud`, and skips sockets for cloud workspaces.
  `PUT /slack/cloud`, `DELETE /slack/cloud?workspace=`.
- **Cloud:** migration `20261016090000_slack_cloud_answers.sql`; `packages/cloud`
  `getSlackCloudStatus`, `setSlackCloud`, `deleteSlackCloud`, `SlackCloudStatus`,
  `SlackCloudInput`.
- **Edge Functions:** new `slack-events` (`verify_jwt = false`); `docs-rag` imports the
  Voyage helper from `_shared/voyage.ts`.
- **UI:** the Slack settings card gains a «Cloud answers» section (status, switch, provider,
  model, base URL, AI key, signing secret, Request URL and the matching manifest);
  `slackCloudManifest()` in `lib/slack-manifest.ts`; `slack.cloud.*` i18n in en/uk.

## Verification

- `pnpm --filter @kermanych/api test` — 106 files pass, including `slack-map.spec.ts` (now
  importing the moved functions from core) and the new `slack-cloud.spec.ts` (sockets stop
  in cloud mode and come back when it is off; tokens from another Slack workspace refused;
  a key the provider refuses stores nothing; a save carries this machine's bot token after
  a one-word check; switching off needs no secrets, changing the model needs the key). The
  only failures are the two known ones in `rpc-session.compact.spec.ts`, untouched here.
- `pnpm --filter @kermanych/{core,cloud,ui} test` — pass (209, 158, 615 tests).
  `@kermanych/api typecheck` reports only the existing `jira.controller.ts:350` error;
  `@kermanych/ui typecheck` only the existing `@kermanych/api`-not-built and
  `runtime-messages.spec.ts:13` errors.
- `deno check` (Deno 2.9) of `slack-events/index.ts` and `docs-rag/index.ts` — passes, with
  the relative import of `packages/core/src/slack-answer.ts`.
- Edge handler smoke (throwaway, deleted): the real `handleSlackEvents` under Node with fake
  deps and a stubbed `fetch`. 15 checks: bad signature and a timestamp 301 s old → 401 with
  nothing stamped; unknown workspace → 404; `url_verification` echoes the challenge and
  stamps; a question gets the placeholder, then the answer converted to mrkdwn, from a
  prompt naming the workspace and citing the fragment; a redelivered `event_id` is answered
  once; an untagged thread reply, the bot's own post, another channel, another team and a
  disabled workspace are ignored; nothing indexed → the fixed reply without a model call; a
  tagged follow-up reads only the thread before it and searches root + follow-up; a long
  answer continues in the thread within 3,500 characters per part; a provider 401 becomes
  the apology; the Anthropic and OpenAI-compatible request shapes; Slack Web API calls are
  form-encoded with the bot token.
- Migration (throwaway, deleted): every migration applied in order to PGlite 0.3 with
  pgvector and Supabase role/auth stubs, then 25 checks as `authenticated`, `anon` and
  `service_role`: the first save needs all secrets; a member cannot set or delete; no
  integration → refused; a non-https base URL refused; members see the status with the key's
  last four characters and no secret; a non-member sees nothing; neither client role nor
  the service role can read `workspace_slack_cloud` or `project_doc_chunks` directly, and
  client roles cannot call the `slack_cloud_*` functions; the service role gets the config,
  only this workspace's indexed project, a full-text match, and nothing for another
  workspace's project; event claims dedupe and stamp `events_seen_at`; switching off keeps
  the secrets and stops all documentation; a provider switch is stored; deleting the
  integration cascades the secrets and the events.
- UI: preview api + `quasar dev` in a headless browser, workspace and Slack state injected
  (the preview has no cloud). Checked the «Cloud answers» card not set up, the form
  (provider switch brings `gpt-5` and the base URL field), «Check and turn on» reaching
  `PUT /slack/cloud` and showing its error, the enabled card in English (facts, Request
  URL, «not connecting — cloud answers are on» on the machine line), and «Copy cloud
  manifest» producing `socket_mode_enabled: false` with the workspace's Request URL.
- Not exercised: a live Slack app, a deployed Edge Function and a real AI key — there is
  no Supabase stack (Docker) or Slack workspace on this machine.

## Documentation impact

- `kermanych/README.md` `### Slack` — the two modes, cloud setup, what the cloud holds, the
  migration and the Edge Function to deploy; the secrets table no longer says the service
  role is never used.
