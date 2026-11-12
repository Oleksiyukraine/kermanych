# «Керманич» runs only omp: remove managed claude-code; the provider picks the default mode

## Goal

Developers who picked `claude-code` in Settings and launched tasks in «Керманич» mode ran into a
series of errors. The managed claude backend was added on 2026-09-02 as the alternative to omp,
before Kermanych could host a harness's own TUI. Today `omp`, `claude` and `codex` all run natively
(`docs/specs/2026-10-05-native-sessions.md`, `2026-10-06-native-chats.md`,
`2026-10-16-native-codex.md`).

Agreed with the operator (session `do-we-need-claude-code`, 2026-11-05):

- «Керманич» runs only on omp. The managed claude-code backend is deleted.
- All three native harnesses stay.
- The choice in Settings becomes the **provider**, which picks the default launch mode.
- A «Керманич»-only feature is no longer hidden from a native session. It stays visible but
  blocked, and says that it works only in «Керманич» (omp).

## Context

All line numbers are at `e1ac5b84`.

### Managed claude today

- The managed claude backend is `ClaudeCodeRuntime` (`apps/api/src/runtime/claude-code-runtime.ts`),
  built on `@anthropic-ai/claude-agent-sdk`.
- The backend is chosen per user:
  - the cloud value `profiles.agent_runtime`,
  - cached locally in `auth_session.agent_runtime`,
  - read through `resolveRuntime()` (`runtime/resolve-runtime.ts`),
  - with the dev override `KERMANYCH_RUNTIME`.
- The backend is stamped on `Session.runtime` when the session is created
  (`supervisor.service.ts:1182, :1243, :1770, :1874`).

### Why it keeps breaking

- Managed claude recreates omp's session model with a different identity: a session id instead of a
  session file, plus its own fork, resume and rehydrate.
- So every surface has a `=== "claude-code"` branch:
  - slot-queue restore: `supervisor.service.ts:805`
  - promote: `:1313-1318`
  - relaunch: `:1618`
  - branch: `:1681-1686`
  - wake: `:4006-4026`
  - `spawnOpts`: `:833-851`
- Both bugs fixed on 2026-10-20 were in these branches: promoting a chat (#177) and waking a fork
  before its first message (#180).
- The managed claude session started for this same task (`0d9f2271…`) stopped at its first
  `mcp__kermanych__list_findings` call, received no result, and is still `queued`.

### Other consumers of the same preference

These headless functions also run on the preferred backend:

- the Менеджмент chat and ЦУК (`assistant/rpc-chat-pool.ts:129`)
- release notes (`management/release-notes.service.ts:59-60`)
- Slack answers (`slack/slack.service.ts:272`)
- branch names (`supervisor/branch-name.service.ts:67`)
- the Посіпака preflight (`minion/minion.service.ts:215`)
- the model catalog (`http/models.controller.ts:23`)

### What native sessions lack

- **Refused by the api** with `native_unsupported`:
  - promote, branch and review (`supervisor.service.ts:1306, :1677, :1749`);
  - images (`:1080, :2442`);
  - model and effort changes (`:2691, :2707`).
- **Hidden in the UI:**
  - «⚖ Ревізор» and «⑂ Гілка» (`AgentsPage.vue:348, :353`);
  - in the launcher, the model, effort, images and helpers (`AgentsPage.vue:864-946`);
  - ▶ on a native chat (`ChatPage.vue:106`).
- **«Дизайн»** renders only `KPanel` (`DesignPage.vue:143-195`), so a native design session shows
  an empty panel.
- **Voice** works only through `KPanel` (`2026-11-02-voice-conversation.md`, decision 4).
- **Посіпака** is never native (`supervisor.service.ts:1123`).
- **Тестувальник** runs as its own managed child and accepts a native parent (`:1805`).

### What native claude needs from the managed code

Native claude uses three things from the managed backend's code:

- the SDK, but only to read history (`getSessionMessages`, `native/native-session.service.ts:15`);
- `runtime/claude-history.ts` (`:20`);
- `claudeToolName`, which is exported from `claude-code-runtime.ts` (`:24`).

### How the launch mode is chosen today

- **Remembered choices:**
  - «Нова задача» remembers «Режим» in `localStorage` `kermanych.launcher.mode`
    (`lib/native-session.ts:9-29`, commit `22ce3ad9`).
  - ЦУК launches with that remembered mode (`stores/cuk-chat.ts:341`).
  - «Чат» remembers its chip in `kermanych.chat.mode` (`ChatPage.vue:362-367`).
- **Launches that send no mode, and so run managed:**
  - «Дошка» (`BoardPage.vue`)
  - «Дизайн» (`DesignPage.vue:810`)
  - Jira, Linear and Plane (`api.jiraLaunch` sends `{projectId, transitionId, images}`,
    `lib/api.ts:500-510`)

### Other facts

- If the cloud read of the preference fails, the preference becomes `null`. That raises the
  onboarding gate, which cannot be dismissed (`stores/auth.ts:107-113`, `MainLayout.vue:1419`).
- The operator's registry holds 7 managed `claude-code` rows: 6 agents and 1 archived chat. Their
  session files are in `~/.claude/projects/<folder>/<id>.jsonl` (`entrypoint: "sdk-ts"`).

## Decisions

1. **«Керманич» runs only omp.**
   - **What runs on omp:** every managed spawn. That covers agents, chats, discussions,
     Ревізор, Тестувальник, Дизайн, Посіпака, promote, resume and relaunch.
   - **Deleted:**
     - `ClaudeCodeRuntime` (except `claudeToolName`), `claude-event-map.ts`, `effort-map.ts`,
       `resolve-runtime.ts` and `models/claude-models.ts` (about 620 lines);
     - the claude halves of `auth-failure.ts` and `runtime-check.service.ts`;
     - every `claude-code` branch in the supervisor;
     - `KERMANYCH_RUNTIME`;
     - in core: `AGENT_RUNTIMES`, `AgentRuntimeKind`, `isAgentRuntime` and `managedRuntime`;
     - the `kind` argument of `createRuntime`.
   - **Kept for native claude:**
     - the SDK dependency, for `getSessionMessages`;
     - `claude-history.ts`;
     - `claudeToolName`, which moves next to the native code;
     - `MachineResourcesService.claudeEnv()`.
   - *Rejected:* keeping managed claude for some features. One user would run on two engines, and
     the session code that breaks would stay.

2. **Kermanych's headless AI work also runs on omp, whatever the provider.** This covers the
   Менеджмент assistant and its documentation answers, ЦУК, release notes, Slack answers and branch
   names. Without a usable omp:
   - ЦУК and the Менеджмент chat show a blocking note that names the fix (decision 8);
   - branch naming falls back to the transliterated title, as it does today on any failure;
   - Slack and release notes fail with the existing omp errors.

   *Rejected:* a reduced SDK runtime only for these functions. It keeps a second claude code path
   alive for the sake of users who have no omp.

3. **Native `omp`, `claude` and `codex` stay as they are.**

4. **The «ШІ-провайдер» setting (`omp | claude | codex`) is the default launch mode.**
   - **Mapping:** omp → «Керманич»; claude → native `claude`; codex → native `codex`.
   - **Where the default applies** (anywhere the operator does not pick a mode):
     - «Дошка» ▶;
     - the Jira, Linear and Plane launch dialogs;
     - ЦУК `agent.start`;
     - the «Режим» that «Нова задача» opens with, on every open (it can still be changed there);
     - the «Чат» chip.
   - **No more memory.** Neither the launcher nor the chip remembers the last pick:
     `kermanych.launcher.mode` and `kermanych.chat.mode` go. The default lives in one place, so one
     click can no longer override the setting without anyone noticing.
   - **Always «Керманич», whatever the provider:** design cards (decision 8 blocks the native
     modes for them), Посіпака, Тестувальник, Ревізор and branches.
   - **Where the default is resolved:** in the UI.
     - The api keeps «no `native` = managed».
     - The Jira, Linear and Plane launch endpoints gain `native?: NativeHarness`, validated like
       `POST /sessions/from-task` (`400 unknown native harness`).
     - `createSessionFromTask` refuses `native` for a design card with `native_unsupported`.
   - *Rejected:* the api applying the provider when `native` is absent. That flips the meaning for
     every caller, «Дизайн» and Посіпака included.
   - *Rejected:* a fourth value, native omp. It is one more value to explain, and native omp stays
     one click away in the launcher.

5. **Storage: `profiles.agent_runtime`, reused.**
   - **No migration.** The column is free text. It holds `omp | claude-code | codex`, the harness
     ids, and the UI shows `claude` for `claude-code`.
   - **Existing values:** a stored `claude-code` now means «native claude by default».
   - **Reads and writes:** the UI reads and writes the value directly (`@kermanych/cloud`). Core
     names the type `AgentProvider`, with `isAgentProvider`. It uses the same ids as `NativeHarness`
     but a different meaning: provider omp is «Керманич».
   - **The api no longer needs the provider.** These go:
     - `GET` and `POST /account/runtime`;
     - the sign-in copy in `auth.service.ts`;
     - the reads and writes of `auth_session.agent_runtime`. The SQLite column itself stays,
       unused.
   - **Failed cloud read:** «Керманич» is the default and no gate is shown. A failed re-read for
     the same user (a token refresh while offline) keeps the provider already read; only a
     different user's session starts from «Керманич».
   - *Accepted limit:* an older build reads `codex` as «not chosen» and shows its own gate.
   - *Rejected:* a new `agent_provider` column. It needs a push before shipping and a fallback read,
     only to spare old builds one question.

6. **The onboarding gate offers three choices.**
   - It shows only when the cloud read succeeded and the value is `null`.
   - Each choice says what it means:
     - omp is «Керманич»;
     - claude and codex open the harness's own TUI, and Kermanych's AI functions still need omp.
   - Under the choices is an advisory omp check, because every choice uses omp for those
     functions.

7. **«Потрібен вхід в omp» watches only omp.**
   - `GET /account/runtime/check` drops its `runtime` parameter and checks omp.
   - The same omp check (`RuntimeCheckService`) serves the pill and the gate through that
     endpoint, and the Посіпака preflight directly. Settings runs no check of its own: the pill
     already covers omp everywhere.
   - The pill still shows only for `omp_not_authenticated`. The blocking notes in decision 8 also
     act on `omp_binary_missing`.
   - Native harnesses show their own sign-in in their terminal, as today.
   - A launch-time `omp_binary_missing` counts as an ordinary Посіпака failure, as the preflight
     already treats it; only `omp_not_authenticated` pauses Посіпака as signed out.
   - These codes go: `claude_not_authenticated`, `claude_binary_missing` and
     `runtime_claude_*`.

8. **Blocking elements instead of hiding.** A «Керманич»-only control stays visible in a native
   session, disabled, with the reason «Лише в режимі «Керманич» (omp)».

   | Where | Today | After |
   | --- | --- | --- |
   | ⋯ of a native agent: «⚖ Ревізор» (⌘D), «⑂ Гілка» | hidden; ⌘D does nothing | disabled + reason; ⌘D shows the reason |
   | «Чат», native thread: ▶ «Почати імплементацію» | hidden | disabled + reason |
   | «Нова задача», native mode: model, effort, images, «Помічники» and `/` | hidden | disabled + reason (for model and effort: `/model` in the harness's TUI) |
   | «Нова задача», a design card | every mode | native modes disabled + reason |
   | «Дизайн», a native design session | empty `KPanel` | a blocking note instead of the panel |
   | Header of a native agent or chat: 🎤 | absent | disabled 🎤 + reason |
   | ЦУК and the Менеджмент chat field, omp missing or signed out | the error arrives after a send | a blocking note with the fix (install omp / `omp login`) |

   Тестувальник already works for a native parent, so it does not change.

   *Out of scope:* making Ревізор or branches work natively.

9. **Old managed `claude-code` rows** (`runtime = 'claude-code'`, `native = 0`). A registry fixup
   runs at every start and is idempotent, like the existing backfills.
   - **Rows that become native claude sessions** (`native = 1`):
     - Which rows: plain `agent` rows (no `designDir`, not `minion`, not `tester`) and `chat` rows.
     - How they continue: in the same folder, with `claude --resume <ompSessionId>`. That column
       already holds the id managed claude used.
     - History is read from claude's own file.
     - A row still waiting for a slot loses its queue fields (`pending_prompt`, `slot_queued_at`)
       and stays `stopped`. «Продовжити» starts it.
   - **Every other such row is archived:** discussions, reviews, testers, designs and minion runs.
     An active status becomes `stopped` for these rows too, so an archived run never holds a
     Посіпака slot or keeps its card «running».
     - The api refuses any managed spawn of a row whose runtime is not omp, before any side effect,
       with a new code `managed_claude_removed`.
     - The «Сесія» tab keeps the engine id and its `claude --resume` hint.
   - **History when the worktree is gone.** When the session's folder has no file, the native
     history reader searches every claude project (`getSessionMessages` without `dir`; per the SDK
     typings, an omitted `dir` searches all projects). So a row whose worktree is gone still shows
     its history.
   - *Verified:* `claude --resume <id>` (claude 2.1.285) opens a session the SDK wrote
     (`entrypoint: "sdk-ts"`) and shows its earlier turns (see Verification).
   - *Rejected:* retiring every row. Running agents could then not be continued inside Kermanych.
   - *Rejected:* a read-only managed path over the SDK. That is a second claude path.

10. **The model catalog is omp only.**
    - `/models` lists omp's catalog.
    - The refetch on a provider switch (`loadModels(true)`) goes.
    - Model ids from the claude catalog on cards and projects are dropped at launch by `validModel`.
      This rule already exists.

### Not in this task

- **Dropping the SDK and its ~191 MiB platform package from the app.** This needs Kermanych's own
  reader for claude's JSONL history.
- **`FAST_MODEL = "claude-sonnet-5"`** (`assistant/models.ts:10`) for ЦУК and documentation answers.
  It stays as it is on omp.

## Changes

### `packages/core`

- `runtime.ts`:
  - remove `AGENT_RUNTIMES`, `AgentRuntimeKind`, `isAgentRuntime` and `managedRuntime`;
  - add `AgentProvider`, `isAgentProvider` and the provider → launch-mode mapping.
- `i18n-codes.ts`: remove the claude codes; add `managed_claude_removed`.
- `types.ts`: the `notice` RpcEvent loses `code` (no runtime tags one any more); comments.
- `language.ts`: fix the comments.

### `packages/cloud`

- `account.ts`: the provider helpers for `profiles.agent_runtime`.
- `types.ts`: remove `Profile.agentRuntime`, which nothing reads or writes.
- `index.ts`.

### `apps/api`

- **Delete:** the files listed in decision 1.
- **Trim:** `auth-failure.ts` and `runtime-check.service.ts` (omp only); `agent-runtime.ts`
  (`createRuntime(opts)` and the claude-only options); `one-shot.ts` (no `kind`).
- `supervisor/supervisor.service.ts`:
  - remove `runtimeFor()` and every claude branch;
  - add the `managed_claude_removed` guard;
  - refuse a native design card.
- **Spawn omp without a preference:** `assistant/rpc-chat-pool.ts`, `release-notes.service.ts`,
  `slack.service.ts`, `branch-name.service.ts`, and `minion.service.ts` (whose preflight checks
  omp).
- `models/models.service.ts` and `http/models.controller.ts`: omp only.
- `http/account.controller.ts`: only the omp check stays; the language endpoints are unchanged.
- `auth/auth.service.ts`: no provider copy.
- `registry/registry.service.ts`: the fixup; remove `agentRuntime` from the cached row.
- `http/session-failure.ts`: omp codes only.
- Jira, Linear and Plane: the controllers and services accept `native`.
- `native/native-session.service.ts`: the claude tool-name map (`CLAUDE_TOOL_NAMES`) moves here;
  the history fallback.
- `supervisor/transcript-reducer.ts`: no coded-notice passthrough.
- `supervisor/supervisor.service.ts` / `machine/watchdog.service.ts`: the watchdog re-baseline on
  `ready` (managed claude reported it late) goes; `startChild` takes the baseline after `start()`.
- `management/management-prompt.ts`: remove the `mcp__` prefix line.

### `apps/ui`

- `stores/auth.ts`: the provider, without the gate on a failed read.
- `layouts/MainLayout.vue`: the gate with three choices.
- `composables/useProviderSignIn.ts` → `stores/omp-check.ts`: one shared omp check for the pill
  and the ЦУК / Менеджмент composer (`components/assistant/AssistantComposer.vue`,
  `CukAssistant.vue`).
- `pages/SettingsPage.vue`: the provider select; the note and blurb are rewritten.
- `lib/native-session.ts`: no `readLaunchMode` / `writeLaunchMode`; a default-mode helper (the
  provider plus the design-card rule).
- `AgentsPage.vue`: the launcher default and the blocking elements.
- `ChatPage.vue`: the chip default; ▶ disabled.
- `BoardPage.vue`, `JiraLaunchDialog.vue`, `LinearLaunchDialog.vue`, `PlaneLaunchDialog.vue`: send
  `native`.
- `DesignPage.vue`: the blocking note.
- `stores/cuk-chat.ts`: the provider default.
- The ЦУК and Менеджмент chat fields: the omp note.
- `KPanel.vue`: remove the claude todo-lane guard.
- `lib/session-auth.ts`, `lib/api.ts`, `stores/orchestrator.ts` (no `force`).
- i18n en/uk.

### Tests

- **Delete:**
  - `claude-code-runtime`, `claude-event-map` (incl. `.reduce`), `effort-map`, `runtime-resolve`,
    `runtime-factory`, `supervisor.runtime-pref`;
  - the claude cases of `auth-failure`, `runtime-check`, `runtime-launch-error`, `models.runtime`,
    `management-runtime`, `supervisor.chat-review-runtime`, `supervisor.branch-runtime`,
    `supervisor.resume`, `supervisor.runtime-launch-failure`, `supervisor.sign-in`,
    `transcript-parity`, `account.controller`, `registry.auth` and `registry.runtime`;
  - the claude cases of `packages/core/test/runtime.spec.ts` and `packages/cloud/test/account.spec.ts`.
- **Keep:**
  - the backend-neutral skills cases of `claude-event-map.usage.spec.ts`, which move to a spec of
    their own;
  - every native case.
- **Update:**
  - `apps/ui/test/viewer-prefs.spec.ts`, whose launcher memory goes;
  - `native-session.spec.ts`;
  - `runtime-messages.spec.ts`.
- **Add, only for consumer-visible behaviour:**
  - which rows the fixup flips or archives, and that a second run changes nothing;
  - the refusal of a managed spawn for a non-omp row;
  - the refusal of a native design card;
  - the `native` check on tracker launches;
  - the UI default mode for each provider × design-card combination.
- **Added:** `assigned-skills-prompt.spec.ts` (the skills cases moved out of
  `claude-event-map.usage.spec.ts`), `jira.controller.spec.ts` (the tracker `native` check).

## Verification

Run on 2026-11-05 with claude 2.1.285 and omp 18.12.1. vitest 2.x needs `--minWorkers=1` next to
`--maxWorkers=4`.

- **Suites,** one at a time: `packages/core` 320 passed; `packages/cloud` 194 passed, 72 skipped
  (the existing Supabase-backed cases); `apps/api` 1306 passed, 4 skipped; `apps/ui` 928 passed.
  `tsc --noEmit` (api) and `vue-tsc --noEmit` (ui) report no errors.
- **`git grep`:** no `ClaudeCodeRuntime`, `resolveRuntime`, `KERMANYCH_RUNTIME`,
  `AgentRuntimeKind`, `isAgentRuntime`, `managedRuntime`, `runtime_claude_`, `readLaunchMode` or
  `useProviderSignIn` in code. `claude-code` appears only as the native harness id, the provider
  value and the legacy-row handling.
- **`claude --resume` on an SDK session**, before the fixup relied on it: a copy of an SDK-written
  session (`entrypoint: "sdk-ts"`) in a throwaway folder, opened in a pty with
  `claude --resume <id> --fork-session`: after the trust dialog the TUI showed the earlier turns
  and waited at its prompt. Nothing was sent; no file was written.
- **Smoke run:** the built api in preview mode (isolated DB) and the UI in the session browser, on
  a throwaway git repository with a worktree and a copy of a real SDK session file.
  - **Legacy rows.** Seeded: a managed `claude-code` agent (`queued`, with a queued prompt), its
    discussion, a merged managed agent with no worktree, and a native design row. After start:
    the agent was native, `stopped`, its queue fields empty; the discussion archived; the merged
    agent native. `POST /sessions/<discussion>/message` and `/resume` answered
    `400 {code: managed_claude_removed}`. `GET /sessions/<id>/transcript` returned the earlier
    turns for the agent (its worktree) and for the merged agent (no worktree: the no-`dir`
    fallback). «Продовжити» ran `claude --resume <id> --settings … --mcp-config …`; after the trust
    dialog the TUI showed the earlier turns. «Зупинити» left no claude process.
  - **Provider default** (the provider set in the store; the preview has no cloud profile): omp →
    «Нова задача» opened in «Керманич»; claude → `claude`; codex → `codex` (nothing remembered
    between opens). The «Чат» chip followed the provider; «+ Новий» with claude opened a native
    claude chat, and the automatic first chat was managed, stamped `runtime = omp`.
  - **Blocking elements.** On the native agent ⋯ showed ⚖ and ⑂ dimmed; a click and ⌘D toasted
    «Лише в режимі «Керманич» (omp)»; 🎤 in the header the same. The native chat's ▶ and 🎤
    toasted the reason and promoted nothing. In a native «Режим» the launcher's Хелпери,
    Зображення, model and effort were blocked, the model row's tooltip naming `/model`. «Дизайн»
    showed the note for the native design row.
  - **omp check.** `GET /account/runtime/check` → `{ok: true}`; `GET /account/runtime` → 404. With
    the shared check set to `omp_binary_missing`, ЦУК showed the note and disabled its field,
    Хелпери, attach and send; «Перевірити ще раз» re-ran the real check and cleared it.
    `omp_not_authenticated` raised the top-bar pill «Потрібен вхід в omp». With the provider
    unset, the gate showed the three choices with their hints and «omp відповідає.». Settings →
    «ШІ-провайдер» offered omp — «Керманич» / claude — власний TUI / codex — власний TUI.
  - **Not exercised:** «Дошка» ▶ and the tracker dialogs in the UI (the preview has no cloud
    board; covered by the `defaultLaunchMode` cases and the tracker controller test); an api
    without omp on `PATH` (its verdict is covered by `runtime-check.spec.ts`); the Менеджмент field
    (the preview has no workspace; it is the same composer as ЦУК's); writing the provider from
    the gate or Settings (the preview has no Supabase).

## Documentation impact

- **`kermanych/README.md`:**
  - the intro (`:9-13`, `:19-20`) and «Prerequisites» («Claude signed in», `:32-40`);
  - «Runtime preference» (`:44-77`) becomes the provider, including the `settingSources` paragraph;
  - «Signed out» (`:122`);
  - the language section (`:147-151`);
  - Slack (`:545-546`);
  - «Native sessions» («Launches from «Дошка» … stay managed», `:928-929`) and «Native chats» (the
    chip memory, `:947-948`);
  - the branch slug (`:1447-1449`);
  - the skills table (the managed `claude-code` column, `:1744-1763`);
  - the docs policy (`:1878-1879`);
  - ЦУК («your launch mode», `:1947`);
  - Менеджмент (the claude MCP note; «chosen runtime», `:2340`).
- **`kermanych/docs/claude-resource-limits.md`:** the limits now reach native claude only.
- **«Superseded in part by `docs/specs/2026-11-05-remove-managed-claude-code.md`»** notes in
  `kermanych/docs/superpowers/specs/2026-09-02-claude-code-runtime-design.md` and, under `docs/specs/`:
  - `2026-10-05-native-sessions.md`, `2026-10-06-native-chats.md`, `2026-10-16-native-codex.md`
  - `2026-10-21-ai-login-required.md`, `2026-10-21-machine-resource-profile.md`
  - `2026-10-22-skill-import.md`
  - `2026-10-23-minion-auto-run.md`
  - `2026-10-26-branch-name-from-task.md`
  - `2026-11-04-cuk-control-console.md`
