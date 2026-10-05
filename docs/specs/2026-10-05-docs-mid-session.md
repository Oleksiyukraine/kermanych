# API request and handoff mid-session

- **Date:** 2026-10-05
- **Scope:** `packages/core` (doc-policy prompt), `apps/api` (one route), `apps/ui` (session
  «Документація» tab), README.
- **Builds on:** `docs/specs/2026-09-30-documentation-settings.md`.

## Goal

A frontend developer working with an agent finds out that the API lacks something. Today the
only way to get an API request out of Kermanych is the «Завершити» sheet: tick «Запит на
розширення API», then «Створити ПР» or «Завершити». Both end the task. The actual workflow is
different: the request is needed **now**, mid-task, so a backend agent can start on it while
the frontend work continues. The same holds in reverse for a backend session that owes the
frontend a handoff before the branch is done.

## Context

- `docs/api-requests/` and `docs/handoffs/` are written by the session's agent. It writes them
  on its own when the project's rule is «За потреби» / «Питати», or when «Доповнити
  документацію» asks (`completeDocs`), and that is reachable only from the finish sheet with a
  failing gate.
- The session's «Документація» tab (`AgentsPage.vue`) lists the documents the branch changed,
  each with its kind tag, and nothing else.
- A backend agent starts from a card on the board (`tasks`, `createSessionFromTask`): the card's
  description is the agent's task. The document lives in the frontend worktree, a repository
  the backend agent never sees.

## Decisions

1. **Ask the agent for the document mid-session.** The «Документація» tab gets «Написати запит
   на API» and «Написати хендоф». Each sends the session's agent one Kermanych prompt (like
   «Доповнити документацію») for that one document, with the resolved `api-request` /
   `frontend-handoff` skill inlined, so a project override wins. It works whatever the project
   rule is: the operator asked explicitly. The prompt says "do not change code in this turn";
   the task continues afterwards. Rejected: a regex trigger, which fires only on typed prose and
   which every project would have to configure.
2. **Hand the document to the other side as a board card.** Each `api-request` / `handoff`
   document in the tab gets «Задача з документа». The dialog creates a card in another project
   of the same workspace (the backend for a request, the frontend for a handoff). The title is
   taken from the document's first heading. The description is the document text, prefixed
   with where it came from (project, branch, path). The assignee is optional, as on the board,
   and model/effort come from the target project's defaults. An API request gets platform
   `backend`. «Копіювати текст» in the same dialog covers pasting into a backend session that
   is already running. Rejected: committing the document into the backend repository (another
   checkout, another branch, and the backend agent should design the contract change itself),
   and a link instead of the text (the frontend branch may not be pushed yet).
3. **The text is read from the worktree** (`GET /sessions/:id/file`), so an uncommitted
   document can be handed over as well; nothing waits for a PR.

## Changes

- core `doc-policy.ts`: `DOCS_ASK_FAILURE` (finish-sheet kind → gate failure) and
  `docsWritePrompt(kind)`; the per-kind asks are shared with `docsCompletionPrompt`.
- api: `SupervisorService.writeDoc(id, kind)`; `POST /sessions/:id/docs/write { kind:
  "apiRequest" | "handoff" }` → `{ sent: true }`; 400 for an unknown kind or a non-agent
  session.
- ui: `api.writeDoc`, `store.writeDoc`; the «Документація» tab toolbar; the «Задача з
  документа» dialog (`board.createTask`); en/uk strings.
- README «Project documentation».

## Verification

- `apps/api/test/supervisor.docs-gate.spec.ts` (11 tests pass): the write prompt carries the
  one ask and the resolved skill, a project override winning, with the documentation switch
  off; a chat is refused. UI (533) and core (186) suites pass.
- Smoke on a preview api (`KERMANYCH_PREVIEW=1`, temp DB, a real worktree with an
  uncommitted `docs/api-requests/2026-10-05-presence-events.md`) + `quasar dev`:
  `POST …/docs/write {"kind":"spec"}` → 400 `unknown document kind`. In the «Документація»
  tab both buttons render. The document row has «Задача →». With cloud projects injected into
  the store, the dialog offers only the other project of the same workspace, prefills the title
  from the heading and the description with the origin line. «Копіювати текст» puts that text
  on the clipboard. «Створити задачу» passes `board.createTask` `platform: backend`, the target's
  default model/effort and the picked assignee. «Написати запит на API» reaches the supervisor,
  which tries to spawn the runtime (omp was left off PATH on purpose, so it reported
  `spawn omp ENOENT`).

## Documentation impact

README «Project documentation» describes both actions and the route.
