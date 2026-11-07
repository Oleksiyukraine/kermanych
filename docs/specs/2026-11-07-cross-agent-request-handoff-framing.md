# API request and handoff: what binds the other side, and what is a proposal

- **Date:** 2026-11-07
- **Scope:** `packages/core` (default skills `api-request`, `frontend-handoff`; the doc-policy
  asks), `apps/ui` (the «Задача з документа» dialog, `lib/doc-task.ts`, i18n), README.
- **Builds on:** `docs/specs/2026-10-05-docs-mid-session.md` (the dialog and the mid-session
  prompts), `docs/specs/2026-10-08-deep-analysis-task.md` (the card flag).

## Goal

A frontend session writes `docs/api-requests/…` and hands it to the backend project as a card
(«Задача →»). The frontend agent does not know the backend's architecture, so its proposed
contract rests on guesses: a table that does not exist, filtering in the wrong layer, an endpoint
shape that fights the backend's conventions. The backend agent gets the document as its task and
implements it as written. The same happens in reverse, less sharply: a backend handoff carries
the backend agent's guesses about the client (polling, caching, UI states), and the frontend
agent takes them as requirements.

The operator offered two ways out: write the documents as a business task (no contract), or
head them with "this is a reference, not an instruction". Neither is taken as is (see Rejected).

## Context

- `api-request` (`packages/core/src/skills.ts`) asks for What / Why / **Proposed contract**
  ("mark it as a proposal the backend may change") / Until it ships / Existing API checked. The
  client's real needs and the author's guesses about the backend share one section.
- `frontend-handoff` lists the contract and «API requests answered», with no place for
  non-binding advice and no way to mark what is not on the branch yet. A mid-session handoff
  (`docsWritePrompt`) is written "from what this branch has done so far", so parts of it may
  still change.
- `DocTaskDialog.vue:205` builds the card description as the origin line
  (`agents.docTask.origin`) + the document text. That description is the other agent's whole
  task (`createSessionFromTask`). The card is created without `deepAnalysis`, so the agent starts
  coding at once.
- `board.createTask` already takes `deepAnalysis` (`packages/cloud/src/tasks.ts:224`); the server
  wraps the first prompt in `deepAnalysisPrompt` (`supervisor.service.ts:1793-1800`) and drops it
  for an unattended Посіпака run (`supervisor.service.ts:1316`).
- The same dialog serves a design README (`lib/doc-task.ts:17-20`).

## Decisions

1. **Requirements apart from the proposal (API request).** The `api-request` skill splits the
   client's side into what binds and what does not:
   - **Requirements**: the user flow, the data and events the client needs, the constraints
     (volume, paging, freshness, latency) and what the client code already relies on (a mock's
     shape, a type), with paths. Only what the client truly cannot do without; what it would
     merely like goes into the proposal.
   - **Proposed contract**: a sketch. The backend designs the real one.
   - **Assumptions about the backend**: every guess the proposal rests on, listed so the backend
     confirms or rejects each one.
   - What / Why / Until it ships / Existing API checked stay. The reader line says the backend
     developer knows the backend better than the author.
2. **Fact apart from advice (handoff).** The `frontend-handoff` skill states that the described
   contract is what the backend does and binds the client, and gains:
   - **Not on the branch yet**: parts still being built or likely to change, so nobody
     integrates against them as final (the mid-session case).
   - **Suggestions for the client**: caching, polling, UI states the backend thinks fit. Not
     binding; the frontend decides.
   - **API requests answered** also says where the contract differs from the request's proposal,
     and why, so the frontend knows what to adapt.
3. **Kermanych frames the card for the receiver, in the description.** The dialog adds one
   paragraph after the origin line, chosen by the document's kind
   (`agents.docTask.framing.apiRequest` / `.handoff`, uk and en, the UI language like the origin
   line). The operator sees it in the description field before the card is created and can edit
   it, and «Копіювати текст» carries it into a session that is already running. The paragraph
   names the parts by meaning, not by heading, so it still reads right when a project overrides
   the skill. Draft (uk):
   - API request: «Це запит від клієнтської сторони, а не готове рішення. Обовʼязкові тут вимоги
     клієнта: сценарій, потрібні дані й події, обмеження і те, на що клієнтський код уже
     спирається. Запропонований контракт і припущення про бекенд — лише пропозиція автора, який
     не бачив цього репозиторію: перевір їх під архітектуру бекенду і зміни, якщо є краще
     рішення. У хендофі для фронта назви, де й чому контракт відійшов від пропозиції.»
   - Handoff: «Це хендоф від бекенду. Описаний контракт уже реалізований (крім частин, позначених
     як ще не готові), тож клієнт під нього підлаштовується; якщо він заважає, винеси це як
     питання, а не обходь. Поради щодо клієнта не обовʼязкові: як будувати UI й клієнтську
     логіку, вирішуєш ти за архітектурою цього репозиторію.»
4. **«Глибокий аналіз» in the dialog.** A `KCheckbox` with the launcher's own label and caption
   (`agents.launcher.deepLabel` / `deepDesc`). On by default for an API request, so the backend
   agent checks the request against the architecture and settles open choices with the operator
   before code. Off by default for a handoff, whose contract is already fact. The value goes to
   `board.createTask` as `deepAnalysis`. Unattended runs keep ignoring it, as today.
5. **Design README unchanged.** No framing, no checkbox: a prototype and its screenshots are the
   specification there, and `implement-from-design` already says how to take them.
6. **The asks follow the skills.** `FAILURE_ASKS` in `doc-policy.ts` (used by «Доповнити
   документацію» and the mid-session buttons, which also work when the skill is overridden)
   names requirements and assumptions for an API request, and «what is not on the branch yet»
   for a handoff. The tab's hints (`agents.docs.write.apiRequestHint` / `handoffHint`, uk and en)
   say the same in a few words.

## Rejected

- **A business task with no contract** (operator's option 1). It drops what the frontend actually
  knows: the shape it already consumes or mocks. The backend builds its own and the frontend
  reworks.
- **A header "this is a reference, do better if you can"** (operator's option 2). It does not say
  *what* may change, so the receiver either ignores it or breaks what the client needs. It is
  written by the authoring agent, and a project override of the skill loses it.
- **The same "requirements / proposal" split for the handoff.** The handoff's contract is built,
  not proposed.
- **The framing in the first prompt on the server** (`createSessionFromTask`). The operator would
  not see or edit it, it would need a new card field (a Supabase migration) to know where the
  card came from, and «Копіювати текст» would not carry it.
- **The framing only in the document, via the skill.** The same loss on override as the header.
- **Deep analysis off for every kind, or no checkbox.** The API request is exactly the case where
  the receiving side should check before building.

## Changes

- core `skills.ts`: `api-request` and `frontend-handoff` bodies (decisions 1, 2), kept terse.
- core `doc-policy.ts`: the `api-request` and `handoff` lines of `FAILURE_ASKS` (decision 6).
- ui `lib/doc-task.ts`: which framing a document gets (`api-request` → request, `handoff` →
  handoff, design README → none) and the deep-analysis default by kind. The dialog asks it, so
  the tab, the Дизайн page and the dialog keep agreeing.
- ui `DocTaskDialog.vue`: the framing paragraph after the origin line; the checkbox, reset to the
  kind's default on every open, hidden for a design README; `deepAnalysis` in `createTask`.
- ui i18n (uk, en): `agents.docTask.framing.*`; updated `apiRequestHint` / `handoffHint`.
- README «Project documentation»: API requests (requirements vs proposal), the handoff's new
  sections, and the card's framing and «Глибокий аналіз» default.

## Verification

- `apps/ui/test/doc-task.spec.ts`: the framing and the deep-analysis default per kind (API
  request: framed, on; handoff: framed, off; design README: neither).
- Core and ui suites pass (`--maxWorkers=4`, one run at a time).
- Smoke in the dev UI with an uncommitted `docs/api-requests/…` and `docs/handoffs/…` in a
  session: «Задача →» on the request shows the request framing under the origin line and the
  checkbox ticked; on the handoff, the handoff framing and the checkbox clear; on a design README,
  neither. «Створити задачу» passes `deepAnalysis` as ticked (the created card shows the flag).
- The new skill bodies: `docsWritePrompt` for each kind, with the resolved skill inlined, shows
  the new sections (`supervisor.docs-gate.spec.ts` still passes).

## Documentation impact

README «Project documentation» (see Changes).

## Verification results

- `pnpm --filter @kermanych/core test`: 32 files, 445 tests pass. `pnpm --filter @kermanych/ui test`:
  89 files, 968 tests pass (the three new `doc-task.spec.ts` cases included); `vue-tsc --noEmit` clean.
  `apps/api` `supervisor.docs-gate.spec.ts`: 15 pass.
- Smoke on the preview (seeded api + `quasar dev`), a worktree with uncommitted
  `docs/api-requests/…` and `docs/handoffs/…`, cloud projects injected into the store and
  `board.createTask` stubbed: the request's dialog shows the origin line, then the request framing,
  then the document, with «Глибокий аналіз» ticked; «Створити задачу» passed `projectId` of the other
  project, its default model and `deepAnalysis: true`. The handoff's dialog shows the handoff framing
  with the box clear, and the call carried no `deepAnalysis`. The design README case is covered by the
  unit test only; it was not opened in the browser.
