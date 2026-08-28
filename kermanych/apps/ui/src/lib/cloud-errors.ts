// apps/ui/src/lib/cloud-errors.ts
// Supabase/PostgREST refusals, in Ukrainian.
//
// Every owner-only policy in this schema refuses a write by matching zero rows
// rather than by raising, and the cloud client throws `new Error(error.message)`
// and drops `error.code` — so the TEXT is all a caller gets. That makes these
// patterns load-bearing, and it is why they live in one module: the sidebar's
// drag-to-move (layouts/MainLayout.vue) and the settings screen's saves
// (pages/SettingsPage.vue) map the same refusals, and two copies of a
// version-dependent regex is how one of them silently stops matching.

/**
 * «Zero rows through .single()», in BOTH of its spellings. PostgREST ≤11 said
 * «JSON object requested, multiple (or no) rows returned»; this server says
 * «Cannot coerce the result to a single JSON object» — AgentsPage.vue records
 * that first-hand, and packages/cloud/test/rls.spec.ts asserts the CODE
 * precisely because the message is version-dependent. Testing one spelling
 * leaves the branch dead against the other server and puts raw English in a
 * Ukrainian pane, so this MUST keep both.
 */
export const NO_ROWS = /rows returned|coerce the result/;

/**
 * A refused MOVE has TWO shapes, from opposite ends of one policy.
 * projects_update_member evaluates USING against the OLD row and WITH CHECK
 * against the NEW one, so: a destination workspace the user does not belong to
 * fails WITH CHECK and Postgres RAISES `42501 new row violates row-level
 * security policy`, while a SOURCE they cannot see fails USING, matches zero
 * rows, and surfaces through .single() as PGRST116 — i.e. as NO_ROWS above. To
 * the operator both are the same sentence. Only a move can produce 42501; every
 * other write in this app is refused the zero-rows way.
 */
export function isMoveRefusal(raw: string): boolean {
  return /42501|row-level security/.test(raw) || NO_ROWS.test(raw);
}

export const MOVE_REFUSAL =
  'Хмара відмовила: переносити проєкт можна лише між воркспейсами, у яких ви учасник';

/**
 * The refusals a workspace MEMBERSHIP write really produces. The first two come
 * from inviteMember / the cloud client, the third from
 * invite_workspace_member's own owner check. Removal needs no branch: a DELETE
 * the policy refuses matches zero rows WITHOUT an error, which the caller
 * catches by re-reading instead.
 */
export function memberErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes('no Kermanych account for')) {
    return 'Немає акаунта Керманича з такою адресою — попросіть колегу спершу увійти через GitHub';
  }
  if (raw.includes('not a valid email address')) {
    return 'Це не схоже на імейл — запрошуємо за адресою, якою колега входить у Керманич';
  }
  if (raw.includes('only the workspace owner can invite')) {
    return 'Хмара відмовила: запрошувати до воркспейсу може лише його власник';
  }
  return raw;
}
