# Finish sheet without documentation checkboxes

- **Date:** 2026-10-05
- **Scope:** `packages/core` (doc policy), `apps/api` (gate, routes, registry), `apps/ui`
  (finish sheet, settings, i18n), `supabase/migrations`, README.
- **Builds on:** `docs/specs/2026-09-30-documentation-settings.md`,
  `docs/specs/2026-10-05-docs-mid-session.md`.

## Goal

«Написати запит на API» and «Написати хендоф» now live in the session's «Документація» tab
(`2026-10-05-docs-mid-session.md`). The «Завершити сесію» sheet still offered the same two
documents as checkboxes («Хендоф для фронта», «Запит на розширення API»). The operator asked to
remove those checkboxes from the sheet.

## Context

- The checkboxes were the `ask` rule of the documentation policy: a kind in `ask` mode got a
  box in the finish sheet (`docsGate.asks`), and a ticked box made the gate require the
  document (`DocsRequested` sent with `GET …/finish?handoff=1&apiRequest=1` and
  `POST …/pr|commit|finish|docs`).
- `DEFAULT_DOCS_POLICY.handoff` was `ask` (box ticked by default); `apiRequest` supported
  `off · optional · ask`.

## Decisions

1. **Remove the `ask` rule, not just the boxes.** Without the boxes `ask` has no input: it
   would either always demand the document (the handoff box opened ticked) or never, i.e. be
   `optional` under another name. `DocsRule` is now `off · optional · required`; handoff
   offers all three, API request `off · optional`. Rejected: hiding the boxes and sending the
   old defaults, which would silently make the handoff mandatory with no way to opt out.
2. **`ask` becomes `optional`.** That is the nearest rule that blocks nothing: the agent writes
   the document where it applies, and the operator asks for it explicitly from the
   «Документація» tab. The default handoff is `optional`.
3. **Migrate stored values.** Supabase migration `20261005100000_docs_policy_drop_ask.sql` and a
   registry start-up update rewrite `"ask"` → `"optional"`. Without them `docsPolicy()` would
   read `ask` as the kind's default, and for `apiRequest` that is `off`. A teammate on the
   previous build reads `optional` as before.
4. **The gate takes no request input.** `DocsGateInput.requested`, `DocsGate.asks`,
   `DOCS_ASK_DEFAULTS`, `docsAsks`, `DocsRequested` are removed; the routes take no flags.
   `DocsAsk` / `DOCS_ASK_FAILURE` are renamed `DocsWriteKind` / `DOCS_WRITE_FAILURE`, which name
   the «Документація» tab's two kinds.

## Changes

- core `doc-policy.ts`: rule set, default handoff, gate without `requested`, policy append
  without `ask` lines; `index.ts` exports.
- api: `SessionsController` finish/pr/commit/docs routes take no body or query;
  `SupervisorService` gate methods take no `requested`; `RegistryService` rewrites stored
  `ask`.
- ui: finish sheet loses the checkboxes and the re-read-on-toggle state; `api`/store calls drop
  the flags; settings hints for `optional` handoff / API request point at the «Документація»
  tab buttons; `ask` strings removed (uk, en).
- supabase: `20261005100000_docs_policy_drop_ask.sql` (data only).
- README «Project documentation».

## Verification
- `pnpm --filter @kermanych/core test`: 183 passed. `@kermanych/cloud` `projects.spec.ts`: 21
  passed. `@kermanych/api` typecheck clean; `vitest run`: 811 passed; the 2 failures in
  `rpc-session.compact.spec.ts` fail the same way on the unmodified tree. `@kermanych/ui`
  typecheck: only the known `runtime-messages.spec.ts` TS2352 and `electron-main.ts` missing
  `@kermanych/api` build; `vitest`: 467 tests passed, 10 files fail to load on Node 25
  (`localStorage.getItem is not a function`), unrelated to this change.
- Registry migration: a SQLite row stored as `{"handoff":"ask","apiRequest":"ask",…}` reopens
  as `optional` for both.
- Supabase migration on Postgres 17: `ask` values become `optional`, `{}` and a non-object row
  are untouched, a second run is a no-op.
- Smoke (preview api on a temp DB with a real worktree + `quasar dev`): `GET …/finish?handoff=1&apiRequest=1`
  → `docsGate {"enabled":true,"failures":["task-spec","docs-impact"]}` (no `asks`, flags
  ignored); `POST …/pr {"handoff":true,"apiRequest":true}` → 400 on the same two failures
  only. With a task document declaring `None`, failures are `[]` without any handoff. The
  «Завершити сесію» sheet shows the missing list and no checkboxes. Settings show handoff
  `Вимкнено | За потреби | Обовʼязково` and API request `Вимкнено | За потреби`.

## Documentation impact

README «Project documentation»: rule table, defaults, finish sheet, API contract, migration.
