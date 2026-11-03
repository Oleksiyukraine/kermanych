# Plan: «Тестувальник» agent

Task document: `docs/specs/2026-11-04-qa-tester-agent.md`. Paths below are under `kermanych/`.

## Steps

1. **Core contract** — `packages/core/src/tester.ts` (tools, scope, refusal, hand-off text, prompt
   blocks, contract), `task-actions.ts` (`QaAgentVerdict`, `item.agent`), `agents.ts` (`tester` entry),
   `types.ts` (`Session.tester`, `qa_checklist_update` event).
   Verify: `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/core test`.
2. **Migration + cloud** — `supabase/migrations/20261104090000_qa_checklist_item_functions.sql`,
   `packages/cloud/src/tasks.ts` (`patchQaItems`, `setQaChecklistIfEmpty`).
   Verify: build; run the functions on a throwaway Postgres (PGlite): patch, untick-drop, clear verdicts,
   set-if-empty on full/empty card, missing item raises.
3. **Api** — SQLite (`sessions.tester`, `tester_accounts`, `tester_settings`), tester settings routes,
   `POST /sessions/:id/qa-run`, MCP gating + `report_qa_result` / `set_qa_checklist` /
   `browser_type_credential`, preview of a tester → parent, `mergeDiscussion` hand-off, finish retires the
   tester, «Створити ПР» keeps an existing checklist, `qa_checklist_update` events.
   Verify: `pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api test`.
4. **Electron** — ephemeral partition for tester targets; credential typing without logging the value.
   Verify: `pnpm --filter @kermanych/ui build -m electron` typecheck (or `vue-tsc`), existing electron tests.
5. **UI** — FinishSheet + QA-tab button with scope choice and refusal hints, verdict badges (QA tab, board
   card), tester child ⤴ «Передати виконавцю», parent «Тестування триває», `TesterPanel` on «ШІ-команда»,
   `NOT_TRIGGERABLE`, ticks through `patchQaItems`, `qa_checklist_update` applied to open details, i18n.
   Verify: `pnpm --filter @kermanych/ui test` (max 4 workers), typecheck; a look in the web preview for
   the settings panel and the disabled button hint.
6. **Docs** — README (QA, ШІ-команда, Session browser).

## Risks and order

- The migration must ship before (or with) the UI/api that call the functions: an old database answers
  the RPC with «function not found», and the QA tick would fail. Apply it with the release.
- The full tester run needs the desktop app (Electron browser host); the web preview cannot run it.
