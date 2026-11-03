# «Тестувальник»: an agent that walks the QA checklist in the live browser

- **Status:** approved by the operator on 2026-11-04; implemented on `feature/add-qa-tester-agent`.
- **Scope:** `packages/core` (the `tester` agent, QA verdict shape, prompt contract),
  `packages/cloud` (QA item patch / set-if-empty calls), `supabase/migrations` (two QA functions),
  `apps/api` (launch route, tester child session, MCP tools and gating, credentials in SQLite,
  «Створити ПР» keeps an existing checklist, parent finish stops the tester),
  `apps/ui` (FinishSheet and QA-tab button, verdict badges, «ШІ-команда» tester card, child
  session actions), `apps/ui/src-electron` (ephemeral browser partition), README.
- **Builds on:** `docs/specs/2026-11-03-session-browser-preview.md`,
  `docs/specs/2026-10-23-minion-auto-run.md`, `docs/specs/2026-10-05-embedded-browser.md`,
  `docs/specs/2026-10-08-session-browser-rework.md`, `docs/specs/2026-10-21-machine-resource-profile.md`.

## Goal

The operator asked (deep-analysis session, 2026-11-03): add a new agent «Тестувальник». The
«Завершити» popup gets a «Виконати тестування» button, and the QA tab gets the same. The tester
goes item by item through the session's QA checklist and clicks every needed action in the live
browser (the reworked session browser + preview). The tester needs settings on its agent page:
credentials it logs in with, and possibly more.

## Context (before this change)

**The QA checklist** is not a file. It is JSON on the cloud card, `tasks.qa_checklist jsonb`
(`supabase/migrations/20260910090000_task_qa_checklist.sql`), shape
`QaChecklist {generatedAt, sessionId?, items: QaChecklistItem[]}`, item
`{id: "q1"…, text, checked, checkedBy?, checkedAt?}` (`packages/core/src/task-actions.ts:27-43`).
It is produced only by «Створити ПР»: `createPullRequest` appends `QA_CHECKLIST_DIRECTIVE` for a
task-born, non-native session (`apps/api/src/supervisor/supervisor.service.ts:~2582`); the fenced
`kermanych-action` block is captured in `onRpcEvent` (first block per kind per `Live`) and
`applyTaskArtifact` **replaces the whole checklist** (`:2622-2630`), so a second PR run wipes every
tick. The UI ticks an item by rewriting the whole column from its local copy
(`apps/ui/src/stores/board.ts:496-513`, `setQaItemChecked`). A checked item means a person checked
it (`checkedBy` = cloud user id). The QA tab is in `apps/ui/src/pages/AgentsPage.vue:770-791`; the
board card dialog shows the same list (`BoardPage.vue:313-330`). The skill `qa-tester`
(`packages/core/src/skills.ts:202-231`) describes how to compose a checklist.

**Roles** are entries of `AGENTS` (`packages/core/src/agents.ts:276-288`); instruction and skill
overrides live in cloud `ai_agents` / `ai_agent_skills` (no enum: a new id needs no migration) and
are edited in «ШІ-команда» → Агенти (`AiAgentsPanel.vue`, workspace scope). Project scope shows
only `MinionPanel.vue` (machine-local activation in SQLite).

**Browser and preview tools** come from the per-session MCP server `kermanych`
(`apps/api/src/browser/browser-mcp.service.ts`). `tools/list` (`:523-533`): `browser_*` when the
desktop browser host exists and the project platform has a browser; `preview_*` only for
`kind === "agent"`; findings always; `report_outcome` for `session.minion`. Discussion and review
forks are launched with no MCP at all (`supervisor.service.ts:1745, 3796-3799`). The browser page
is per session id; its Electron partition is `persist:kermanych-browser-<projectId>`
(`apps/ui/src-electron/session-browser/browsers.ts:578`), so logins are shared by every session of
a project and survive restarts. `PreviewService.resolve` (`apps/api/src/preview/preview.service.ts:262-274`)
accepts only agent sessions and runs from the session's worktree.

**«Ревізор»** (`reviewSession`, `supervisor.service.ts:1704-1755`) is the precedent for an
independent agent next to the doer: a `kind: "review"` child with `parentSessionId`, running in the
parent's worktree with `read/grep/glob` only, refused while the parent is mid-turn. Its result goes
back with ⤴ (`mergeDiscussion`, `:1756-1790`), which sends a labelled message into the parent and
retires the child; «Відкинути» deletes it.

**Secrets.** The vault («Сховище») is cloud-only and the api never reads it. Local tokens (Jira,
Linear, voice) are plaintext SQLite columns on this machine (`registry.service.ts:455-475`). `.env`
is copied into every worktree.

## Decisions

### 1. The tester is a separate child session that cannot edit code

A run is a new child session of the doer, named `тестування: <doer name>`, of
`kind: "review"` stamped `tester: true` (new additive SQLite column `sessions.tester`, the same
pattern as `minion`/`design_dir`). It runs in the parent's worktree with `read/grep/glob` (as a
review fork) plus the MCP server described in decision 8. It never edits or commits code.

Reusing `kind: "review"` gives, unchanged, the child's place in the session tree, the ⤴ / discard
actions and the «wait for the parent's turn» guard. The stamp is what turns on the browser and the
QA tools.

Rejected: a message into the doer's session the way «Комітер» works (the doer would judge its own
work, its context grows, and the doer is busy for the whole run); a separate session allowed to fix
bugs (a second writer on the same branch).

### 2. A verdict per item, next to the human tick

`QaChecklistItem` gets an optional field:

```ts
agent?: {
  status: "passed" | "failed" | "blocked";
  note: string;            // what was done and seen; for failed/blocked — why
  screenshot?: string;     // worktree-relative path under docs/qa/
  sessionId: string;       // the tester session that wrote it
  at: string;              // ISO
}
```

`checked` / `checkedBy` / `checkedAt` keep meaning «a person checked it»; the tester never touches
them. The column is `jsonb`, so the shape change needs no column migration; `toTask`/`toTaskRow`
pass it through.

The tester writes verdicts with an MCP tool, `report_qa_result(itemId, status, note, screenshot?)`,
one call per item, saved immediately. Not a fenced block: the capture keeps only the first block
per session, and a per-item tool survives an aborted run.

Rejected: the agent ticking passed items itself (with or without a verdict) — it mixes «the agent
checked» with «a person checked».

### 3. Concurrent writers: item-level updates in the database

The tester (api) and people (UI) now write the same column concurrently, and today's UI write
rewrites the whole column from a possibly stale copy — it would silently drop a verdict written a
second earlier. One migration adds two `security invoker` SQL functions (RLS and `tasks_guard()`
apply as for a normal UPDATE):

- `qa_checklist_patch_item(p_task uuid, p_item text, p_patch jsonb)` — merges `p_patch` into the one
  item with `id = p_item` inside a single UPDATE. Used by the UI tick (`setQaItemChecked`, still
  optimistic with rollback) and by `report_qa_result`.
- `qa_checklist_set_if_empty(p_task uuid, p_checklist jsonb)` — writes the checklist only when the
  card has none (`items` empty or missing); returns whether it wrote.

`packages/cloud` gets thin wrappers for both.

### 4. Credentials: local, per project, on this machine

New SQLite tables (additive, in `registry.service.ts`), never synced to the cloud:

- `tester_accounts(id, project_id, name, login, password, note, position)`
- `tester_settings(project_id primary key, login_path, notes)`

Each operator enters them on each of their machines. Plaintext, like the Jira/Linear/voice tokens
next to them.

Rejected: a shared cloud table (plaintext passwords visible to the whole project team, new RLS);
a reference to a vault entry (an operator without access cannot run tests, free-form vault fields,
one more cloud dependency) — can be added later as another source without changing the settings
shape.

### 5. The model never sees a password

The prompt lists accounts by name, login and note only. A new MCP tool
`browser_type_credential(ref, account, field: "login" | "password")` resolves the value on the api
and types it into the element through the browser host, like `browser_type`. The tool call shows
only the account name and field; the result never echoes the value.

Accepted risk: the agent can still read a typed value back from the page (`browser_evaluate`,
`browser_snapshot` of a visible field). This guards against accidental leaks into the model,
transcript and logs, not against a deliberate one. `browser_evaluate` stays available.

### 6. The tester drives the doer's preview

`preview_*` called from a tester session act on the **parent's** preview (`PreviewService` resolves
a tester id to its `parentSessionId`); the tester may start it if it is not running. A
`browser_navigate` without a URL opens the parent's preview URL. No second set of dev servers from
the same directory.

Rejected: an own preview on other ports from the same worktree (two `setup` runs racing on
`node_modules`, lock files, local databases; double RAM/CPU).

### 7. A clean, temporary browser per run

The tester's browser view uses an in-memory partition `kermanych-tester-<sessionId>` (no
`persist:`), so each run starts logged out with empty storage and never logs the operator out of
the project partition. The partition dies with the view when the tester session is retired or
deleted. `BrowserTarget` gains the information the Electron side needs to pick it (e.g.
`ephemeral: true`); every other session keeps `persist:kermanych-browser-<projectId>`.

Accepted cost: an OAuth/SSO login the agent cannot pass has to be done by the operator in the
tester's «Браузер» tab on every run.

Rejected: the shared project partition (dirty state, logouts hit the operator); a per-project
switch (one more setting before anyone needs it).

### 8. What the tester session gets

`tools/list` for a session with `tester === true` (and `kind === "review"`):

| Tool | Condition |
|---|---|
| `browser_*` (all 17) | browser host present and platform has a browser — as for agents |
| `browser_type_credential` | same, tester only |
| `preview_*` | same, acting on the parent (decision 6) |
| `report_qa_result` | tester only |
| `set_qa_checklist(items[])` | tester only; refused when the card already has a checklist (decision 9) |
| `report_finding` / `list_findings` | always, as today |

The launch path gives the tester child the MCP binding (`browser.bindingFor(child.id)`), unlike other
review forks, both at first launch and on resume (`:3796-3799`). The operator's «Агент» pause applies
to the tester's own page as to any session.

### 9. No checklist yet

- **Session without a card** (`taskId` empty): the button is disabled with a hint that testing
  works only for sessions started from a card.
- **Card without a checklist**: the tester first composes one following the `qa-tester` skill
  (resolved by name, added to the prompt like `deep-analysis`), from the task, the spec and the diff,
  writes it with `set_qa_checklist`, then walks it. The checklist is visible and editable on the QA
  tab like any other.

Rejected: a local SQLite checklist for card-less sessions (a second checklist store and render path).

### 10. «Створити ПР» keeps an existing checklist

`createPullRequest` reads the card first; when it already has a non-empty checklist, the
`QA_CHECKLIST_DIRECTIVE` is not appended. When the read fails, the directive is not appended either
(never risk overwriting). `applyTaskArtifact` writes through `qa_checklist_set_if_empty`, so a block
that races in anyway cannot wipe ticks and verdicts.

Rejected: regenerate-and-merge by item text (the model rewords items every time, so nothing would
match); always overwrite (today's silent data loss).

### 11. Which items a run checks

- The first run (no item has a verdict) checks every item.
- When verdicts exist, «Виконати тестування» offers **«Непройдені»** (default: failed, blocked and
  never-tested items) and **«Усі»**. The same control on the FinishSheet and on the QA tab.
- At launch, the `agent` verdicts of the items in scope are cleared (they describe old code).
- Human ticks are ignored for scope: the tester checks an item whether or not a person ticked it.
- At most one tester per doer session. While one is running, the button reads «Тестування триває»
  and selects its session.

Rejected: always all items (slow and costly after a one-bug fix); per-item selection (a second set of
checkboxes next to the human ones).

### 12. When it may start

`POST /api/sessions/:id/qa-run` with `{ scope: "all" | "open" }` refuses, with a message the UI shows
as the disabled button's hint, when:

- the session is not `kind: "agent"` or has no worktree / is finished;
- the session has no `taskId` (decision 9);
- the doer is mid-turn (`thinking` / `tool`), as for «Ревізор»;
- a tester of this session is already running;
- there is no browser host (web build, not the desktop app) or the project platform has no browser
  (`backend`, `mobile`).

While the tester runs, the doer can still be messaged; its header shows «Тестування триває». The tester
takes an agent slot like any session and waits in the queue when none is free
(`docs/specs/2026-10-21-machine-resource-profile.md`). Verdict notes are written in the agent
communication language (`agentLanguage`), like findings.

Rejected: always (the doer may change code and restart the preview mid-test); blocking the doer's
input for the whole run.

### 13. The end of a run: ⤴ «Передати виконавцю» or «Відкинути»

The tester ends its turn with a short summary. The operator then:

- **⤴ «Передати виконавцю»** — sends the parent one message labelled `[Тестування «<name>»]` with
  every `failed` / `blocked` item of this run, its note and screenshot path, then retires the child
  (the existing `mergeDiscussion` path, with the message built from the verdicts instead of the last
  assistant text). When every item passed, the button only retires the child, sending nothing.
- **«Відкинути»** — deletes the child without a message (the existing discard).

Retiring or deleting the child closes its browser view and with it the temporary partition.
Finishing the parent (`finishSession`, `closeMerged`) stops and retires a running tester before the
worktree is removed.

Screenshots are saved with `browser_screenshot(path)` under `docs/qa/<YYYY-MM-DD>-<session-slug>/`
of the worktree. The tester never commits; the doer or the operator decides.

Rejected: sending failures to the doer automatically (the doer would «fix» the tester's
misunderstandings with no human in between).

### 14. Settings: the «Тестувальник» card in «ШІ-команда» → Агенти

- **Project scope** — a new `TesterPanel.vue` under `MinionPanel`, machine-local (decision 4):
  - **Акаунти** — ordered list of name/role, login, password (masked, «показати»), note; add,
    edit, delete, reorder.
  - **Сторінка входу** — optional path such as `/login`.
  - **Нотатки для тестувальника** — free text: test data, limits, «не натискати X».
- **Workspace scope** — the instruction and skill sequence, through the existing `AiAgentsPanel`
  (the new `AGENTS` entry shows up there by itself).

Api: `GET /api/tester/projects/:id` and `PUT /api/tester/projects/:id` (settings + full accounts
list). The GET returns passwords to the local UI only (same trust as the other local tokens); the
agent never gets them (decision 5).

Not now: model / effort choice (no agent has it), a time limit per run, the browser-partition switch.

### 15. The `tester` agent and its contract

A new `AGENTS` entry `{ id: "tester", labelKey: "agents.role.tester", kind: "session" }` with an
English instruction template and holes: `task`, `items` (the in-scope items with ids), `accounts`
(name, login, note — never passwords), `loginPath`, `notes`. Kermanych appends a contract after the
(possibly overridden) instruction, the way `MINION_OUTCOME_CONTRACT` is appended, so no override can
drop it:

- start or reuse the preview, open it; log in with `browser_type_credential` when an item needs an
  account;
- for each in-scope item, in order: perform it in the browser, then call `report_qa_result` exactly
  once; `blocked` when the item cannot be performed (no account with the needed role, OAuth needed,
  preview fails) with the reason;
- a screenshot for every `failed` item;
- do not edit files, do not commit;
- finish with a one-paragraph summary.

The id is added to `NOT_TRIGGERABLE` (`apps/ui/src/lib/settings.ts`): a tester run needs a parent and
a scope, which a trigger does not provide. i18n: `agents.role.tester` = «Тестувальник» (uk) /
"Tester" (en).

### Out of scope

- Testing native sessions' work is allowed (the tester is its own managed session), but
  «Передати виконавцю» into a native parent goes through `deliverNative` as text only.
- Mobile and backend projects (no browser).
- Vault-sourced credentials, a shared cloud credential store.
- Automatic test runs (e.g. after «Створити ПР» or from «Посіпака»).

## Changes

**`packages/core`**
- `task-actions.ts`: `QaAgentVerdict` type, `QaChecklistItem.agent?`; helpers `qaItemsInScope(checklist, scope)`
  and `qaHandoffText(name, items)`; `buildQaChecklist` unchanged.
- `agents.ts`: `TESTER_AGENT_ID`, the `tester` entry and instruction, `TESTER_CONTRACT`.
- `types.ts`: `Session.tester?: boolean`; tester settings/account types.
- tests: scope selection, handoff text (failed/blocked only, empty when all passed), instruction holes.

**`supabase/migrations`**
- `2026110410xxxx_qa_checklist_item_functions.sql`: `qa_checklist_patch_item`,
  `qa_checklist_set_if_empty` (`security invoker`, `grant execute to authenticated`).

**`packages/cloud`**
- `tasks.ts`: `patchQaItem(client, taskId, itemId, patch)`, `setQaChecklistIfEmpty(client, taskId, checklist)`;
  `toTask` keeps `agent` on items.

**`apps/api`**
- `registry.service.ts`: `sessions.tester` column; `tester_accounts`, `tester_settings` tables and accessors.
- new `tester/` module: settings controller (`/api/tester/projects/:id`), the MCP tools
  (`report_qa_result`, `set_qa_checklist`, `browser_type_credential`).
- `browser-mcp.service.ts`: tester gating in `tools/list` and `tools/call`; preview calls and the
  URL-less `browser_navigate` of a tester go to the parent.
- `preview.service.ts`: `resolve` maps a tester id to its parent.
- `supervisor.service.ts`: `runTester(parentId, scope)` (guards of decision 12, clears in-scope
  verdicts, creates the child, prompt + contract + `qa-tester` skill when the checklist is empty,
  MCP binding at launch and resume); `mergeDiscussion` builds the tester handoff from verdicts;
  `finishSession` / `closeMerged` retire a running tester first; `createPullRequest` reads the card and
  skips the directive (decision 10); `applyTaskArtifact` uses `setQaChecklistIfEmpty`.
- `sessions.controller.ts`: `POST /sessions/:id/qa-run`.
- `browser-host.ts`: `BrowserTarget` carries the ephemeral flag; `typeSecret` (or `type` reused) so the
  value is not logged.

**`apps/ui/src-electron`**
- `session-browser/browsers.ts`: in-memory partition `kermanych-tester-<sessionId>` for ephemeral
  targets, `guardPartition` applied to it as well.

**`apps/ui`**
- `lib/api.ts`, `stores/orchestrator.ts`: `runTester(id, scope)`; tester settings calls.
- `stores/board.ts`: `setQaItemChecked` through `patchQaItems`.
- `components/agents/FinishSheet.vue`: «Виконати тестування» (with the «Непройдені / Усі» choice,
  disabled-with-hint, «Тестування триває» link).
- `pages/AgentsPage.vue`: the same control in the QA tab header; verdict badges ✓ / ✗ / ⏸ with note and
  screenshot path per item; tester child: ⤴ titled «Передати виконавцю»; parent header «Тестування
  триває».
- `pages/BoardPage.vue`: verdict badges (read-only) in the card dialog.
- `components/settings/TesterPanel.vue` + `pages/AiTeamPage.vue` (project scope).
- `lib/settings.ts`: `tester` in `NOT_TRIGGERABLE`.
- i18n uk/en.

## Implementation notes

Details settled while building, within the decisions above:

- The tester child has **no `taskId`** (its status must never mirror onto the card). Its QA tab shows
  the doer's card checklist, live, without the run button; the tools write the doer's card.
- Screenshots a tester saves with `browser_screenshot(path)` land in the **doer's** worktree (the
  child has none); `report_qa_result` accepts a screenshot only when that file exists.
- `scope: "open"` with every item already passed is refused by the api; the button then preselects
  and locks «Усі» with a hint.
- The hand-off message is labelled with the tester session's name: `[тестування: <doer>]: …`.
- The ephemeral flag reaches Electron from both sides: the api's `BrowserTarget.ephemeral` and the
  renderer's `show` / `navigate` / `openPreview` / `setViewport` IPC (`session.tester`), so a view the
  operator opens first is already in `kermanych-tester-<id>`. `close(id)` clears that partition's storage.
- A tester waiting for a slot keeps its opening prompt in `pendingPrompt`, so `restoreSlotQueue`
  restarts it after an api restart.
- A tester that ended in `error` / `stopped` still counts as «running» for its doer until it is
  handed over or discarded: one run per doer at a time.

## Verification

- **Unit (core):** scope selection, handoff text, instruction holes/contract present after an override.
- **Api tests:** `qa-run` refusals (no card, mid-turn, running tester, no browser host, platform);
  `tools/list` for a tester vs a plain review fork vs an agent; `browser_type_credential` result and
  transcript never contain the password; preview calls from a tester resolve to the parent;
  `createPullRequest` without the directive when a checklist exists; finish retires the tester.
- **UI tests:** the button states in FinishSheet and the QA tab; a verdict written by the tester is not
  lost by a concurrent tick (store goes through the item patch).
- **Migration:** apply locally, call both functions as a project member and as a non-member (RLS refuses).
- **Smoke (desktop app):** on a web project with a card and checklist, run «Виконати тестування»;
  watch the tester's «Браузер» tab log in with a configured account (password not visible in the Лог),
  verdicts appear on the QA tab item by item, ⤴ sends the failed items to the doer, the tester's
  partition does not log the operator out of the project's browser. The browser host exists only in the
  desktop build, so this smoke needs the Electron app; the web preview of Kermanych cannot exercise it.

## Documentation impact

- `kermanych/README.md`: the QA section (verdicts, «Виконати тестування», «Створити ПР» keeps the
  checklist), «ШІ-команда» → Агенти (the tester card), Session browser (the tester's temporary
  partition, `browser_type_credential`).
- This spec; no new runbook.
