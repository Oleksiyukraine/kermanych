# Plan: skill self-improvement

Task document: `docs/specs/2026-11-04-skill-self-improvement.md`. Paths below are under `kermanych/`.

**Status:** steps 1–6 done (2026-11-05). The suites pass, and the migration was run on PGlite. The
column, the entry view, the narrow layout and the switch were checked in the live preview, and a
real omp chat called the tool. Two things are still open:

- the operator's pick of the column's look (screenshots in
  `docs/design/2026-11-04-cuk-notifications/`);
- a successful write against a real cloud. The preview has no cloud, and there is no Docker
  here for a local stack.

## Steps

1. **Migration.** `supabase/migrations/20261104120000_skill_improvements.sql` creates:
   - the `skill_improvements` table and its owner-only RLS;
   - the trigger that keeps the newest 100 records per user;
   - the table's place in the Realtime publication;
   - the `profiles.skill_improvement` column.

   Verify: run the migration on a throwaway Postgres (PGlite). Check the policies, the pruning at
   100 and the column default.
2. **Core contract.** `packages/core/src/skill-improvements.ts` holds the tool arguments, the
   exact-once edits, the record and entry types, the rollback plan, the share target and the
   line diff. Export it from `index.ts`.
   Verify: `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/core test`.
3. **Cloud.**
   - `packages/cloud/src/skill-improvements.ts` covers insert, count per session, the light
     list, a full read, the full records of one skill, the state and seen updates, and the
     Realtime binding.
   - `skills.ts` gets `getAiSkill`.
   - `account.ts` gets the switch.

   Verify: `pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/cloud test`.
4. **Api.**
   - SQLite gets `auth_session.skill_improvement`. `AuthService` hydrates the switch, and
     `GET/POST /account/skill-improvement` reads and sets it.
   - `skills/skill-improvement.service.ts` resolves the skill fresh, refuses, applies the edits,
     and writes the user row and the record.
   - `skills/improve-skill-tool.ts` holds the tool definition and the call.
   - `browser-mcp.service.ts` lists the tool for managed `agent` and `chat` sessions with the
     switch on, and dispatches calls to it.

   Verify: `pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api test`.
5. **Ui.**
   - `stores/notification-center.ts` holds the entries, the Realtime binding, the toasts, seen,
     rollback and sharing.
   - `CukNotifications.vue` is the left column, and `SkillImprovementView.vue` is the entry
     view.
   - `AssistantLauncher.vue` gets the three columns and 🔔. `assistant-overlay.ts` gets
     opening on an entry and the mascot's dot.
   - The auth store and Settings get the switch, plus i18n `uk` / `en`.

   Verify: `pnpm --filter @kermanych/ui test` (at most 4 workers) and `vue-tsc --noEmit`. Then
   check in the live preview, and save screenshots of the column variants to
   `docs/design/2026-11-04-cuk-notifications/`.
6. **Docs.** README: ЦУК → «Центр сповіщень», Skills → self-improvement, and the migration note.
   Then the task document's «Verification» with what actually ran.

## Risks and order

- The migration must reach the hosted project before the client ships. An old database answers
  every `skill_improvements` call with «relation does not exist». The tool then refuses
  («Not recorded»), and the column shows an error instead of entries.
- The preview has no cloud. The full path (agent → user row → record → Realtime → toast) needs a
  local Supabase stack, or the hosted project with a signed-in user.
