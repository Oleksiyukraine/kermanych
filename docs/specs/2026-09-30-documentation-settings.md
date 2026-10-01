# Project documentation settings: per-kind rules

- **Date:** 2026-09-30
- **Branch:** `feature/extend-doc-logick`
- **Builds on:** `docs/specs/2026-09-28-mandatory-documentation-design.md`,
  `docs/specs/2026-09-29-docs-required-in-basics.md`

## Goal

«Обовʼязкова документація» is one switch that turns on a fixed bundle: task document
required, plan optional, living docs required, frontend handoff offered in the finish sheet.
The operator asked for:

1. a visually separate «Документація» subsection in the project's «Основне» settings;
2. the documentation split into parts that are configured one by one — the task document
   (spec / plan), the frontend handoff, and the case where the frontend needs something the
   API does not provide yet;
3. anything else that belongs there;
4. overall: more settings, more flexibility.

## Context

- `packages/core/src/doc-policy.ts` — `DOCS_LAYOUT`, `docsGateFailures`, the constant
  `DOCS_POLICY_APPEND`, `docsCompletionPrompt`.
- `projects.docs_required` (cloud) → `CloudProject.docsRequired` → registry
  `docs_required` → `Project.docsRequired`.
- `SupervisorService.docsOpts` (system-prompt append), `docsGate` / `evaluateDocsGate` /
  `assertDocsGate` / `completeDocs`; `POST /sessions/:id/pr|commit|finish|docs`
  `{ handoff?: boolean }`, `GET /sessions/:id/finish?handoff=1`.
- UI: one `KCheckbox` in `SettingsPage.vue` «Основне»; the finish sheet in `AgentsPage.vue`
  shows «Хендоф для фронта» (on by default) and the failure list.

## Decisions

- **Five document kinds, each with its own rule.**

  | Kind (policy key) | Folder | Rules |
  | --- | --- | --- |
  | Документ задачі (`spec`) | `docs/specs/` | off · optional · required |
  | План (`plan`) | `docs/plans/` | off · optional · required |
  | Жива документація (`schemas`) | `docs/schemas/` (or the project's own docs) | off · optional · required |
  | Хендоф для фронта (`handoff`) | `docs/handoffs/` | off · optional · ask · required |
  | Запит на API (`apiRequest`) | `docs/api-requests/` | off · optional · ask |

  - `off` — the policy does not mention the kind; nothing checks it.
  - `optional` — the policy tells the agent to write it when it applies; nothing blocks.
  - `ask` — the finish sheet shows a checkbox for it; ticked, the gate requires the
    document. The handoff box starts ticked (today's behaviour), the API-request box
    unticked (it is the exception, not the rule).
  - `required` — the gate blocks PR / commit / finish without it. `schemas: required` is
    today's `docs-impact` rule, `None` escape hatch included.

  `apiRequest` has no `required`: a request for a missing API only exists when something is
  missing, so demanding one on every branch would force fake documents.
- **The API-request answer to "what if the frontend needs an API extension".** The agent
  must not invent the backend side or silently fake it. It writes
  `docs/api-requests/YYYY-MM-DD-<topic>.md` — what is needed, why, the proposed contract,
  and what the client does until it ships — and names it in the handoff / PR. A new
  default skill `api-request` carries the format; `frontend-handoff` gains a line for the
  backend side: link the request the work answers.
- **Plan gets its own default skill** `task-plan`, so `plan: required` and «Доповнити
  документацію» have a format to point at, overridable per project like `task-spec`.
- **Storage: keep `docs_required` as the master switch, add `docs_policy jsonb`.** An empty
  object reads as the defaults, and the defaults are exactly today's bundle
  (`spec: required, plan: optional, schemas: required, handoff: ask, apiRequest: off`). So
  the migration is additive with no backfill, and a teammate still on the previous build
  keeps reading `docs_required` and behaves as before. Rejected: replacing `docs_required`
  with the JSON alone (dropping a column that older builds select breaks their project
  list) and one column per kind (five columns for one setting).
- **Unknown or invalid values normalise to the default** per kind (`docsPolicy(raw)` in
  core), so a hand-edited row cannot put a kind into a mode it does not support.
- **Gate shape.** `DocsGate` becomes `{ enabled, asks, failures }`: `enabled` replaces
  `required` (with optional rules the old name lies), `asks` lists the kinds in `ask`
  mode so the finish sheet knows which boxes to draw. Request bodies and the query gain
  `apiRequest` next to `handoff`.
- **Policy append is built from the rules** (`docsPolicyAppend(policy)`), not a constant.
  Every kind that is not `off` is listed with its own wording; the "Kermanych refuses …"
  line appears only when something can block.
- **Folders stay fixed.** Custom paths would reach the gate, the badges, the prompts and the
  skills at once; the rules already cover the flexibility asked for.
- **UI.** «Документація» becomes a framed subsection of «Основне»: the master switch, then
  three groups — «Документація задачі» (spec, plan), «Жива документація» (schemas),
  «Фронтенд ↔ бекенд» (handoff, API request) — each kind a segmented control with a hint
  for the chosen mode, and a link to «ШІ-команда → Навички» where the document templates
  (skills) are overridden. The rules are hidden while the switch is off.

## Changes

- **core** `doc-policy.ts`: `DocsRule`, `DocsPolicy`, `DocsAsk`, `DOCS_RULES`,
  `DEFAULT_DOCS_POLICY`, `docsPolicy()`, `docsAsks()`, `DOCS_ASK_DEFAULTS`,
  `docsPolicyAppend()`; `DOCS_LAYOUT.apiRequests`; `DocsLayoutKind` gains `api-request`;
  failures gain `plan`, `api-request`; `docsGateFailures({ policy, paths, specBodies,
  requested })`; `docsCompletionPrompt` covers the new failures. `DOCS_POLICY_APPEND`
  removed. `skills.ts`: `task-plan`, `api-request` defaults; `frontend-handoff` links
  answered requests.
- **cloud** migration `20260930090000_project_docs_policy.sql`
  (`docs_policy jsonb not null default '{}'`); `CloudProject.docsPolicy`, mapping, patch,
  insert.
- **api** registry column `docs_policy TEXT NOT NULL DEFAULT '{}'`; `Project.docsPolicy`;
  supervisor append / gate / completion; controllers take `apiRequest`; `PATCH
  /projects/:id` takes `docsPolicy`.
- **ui** settings subsection, finish-sheet checkboxes driven by `docsGate.asks`, the
  «Документація» tab badge for `api-request`, i18n (uk, en).

## Verification

- `pnpm --filter @kermanych/core test` — 17 files, 186 tests passed (gate per rule,
  `docsPolicy` normalisation, `docsAsks`, policy append, completion skills).
- `pnpm --filter @kermanych/cloud test` — 151 passed, 65 skipped (live-Supabase suites);
  `docs_policy` mapping and patch covered.
- `pnpm --filter @kermanych/api test` — 785 passed; 2 failures in
  `test/rpc-session.compact.spec.ts` (a `subagent_sub` frame in the compact test), a file
  this change does not touch. The docs-gate suite covers per-kind rules over a real
  worktree, the API-request ask, the plan / api-request skills and the rebuilt append.
- `pnpm --filter @kermanych/ui test` — 47 files, 533 tests passed.
- `pnpm --filter @kermanych/api typecheck` — clean. `pnpm --filter @kermanych/ui typecheck` —
  one error, the known `test/runtime-messages.spec.ts` TS2352, which this change does not touch.
- Smoke (api `KERMANYCH_PREVIEW=1 KERMANYCH_SEED=1` on a temp DB, ui
  `VITE_KERMANYCH_PREVIEW=1`, a temp git repo with a code-only worktree bound to a seeded
  project): `PATCH /projects/:id` with `plan: required, apiRequest: ask` →
  `GET …/finish` answered `asks: [handoff, apiRequest]`, failures `task-spec, plan,
  docs-impact`; with `?handoff=1&apiRequest=1` also `handoff, api-request`; `POST …/pr
  {"apiRequest":true}` → 400 `documentation required: task-spec, plan, docs-impact,
  api-request`. In the browser: «Основне» shows the framed «Документація» subsection with
  three groups and five segmented rules; picking a rule changes its hint and marks the pane
  unsaved. The finish sheet stacks «Хендоф для фронта» (ticked) and «Запит на розширення
  API» (unticked); ticking the second adds «немає запиту на API в docs/api-requests»; once
  the four documents exist the list empties and «Створити ПР» / «Завершити» enable. The
  «Документація» tab badges the new file «запит API».

## Documentation impact

- `kermanych/README.md` «Project documentation» (was «Mandatory documentation»): per-kind
  rules, the API-request document, the request fields, the migration and rollout order.
- `docs/specs/2026-09-28-mandatory-documentation-design.md`: points to this document for the
  per-kind rules.
