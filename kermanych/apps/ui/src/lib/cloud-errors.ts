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
 * tasks_guard()'s two ASSIGNMENT refusals
 * (20260830090000_tasks_assignment.sql:45,81), in Ukrainian.
 *
 * Both sentences reach the UI through more than one door: the local API
 * re-raises `task assigned to someone else` from POST /sessions/from-task, and
 * the guard itself raises either one at a board assign or at a create carrying
 * an assignee who is not in the project's workspace. One copy here for the same
 * reason as everything else in this module — two copies of a refusal text is how
 * one of them silently stops matching the sentence Postgres actually sends.
 */
export const ASSIGNMENT_REFUSALS: Record<string, string> = {
  'task assigned to someone else': 'Задача призначена іншому учаснику — запустити її може лише він.',
  'assignee is not a workspace member': 'Цей користувач не входить у воркспейс задачі.',
};

/**
 * The same two refusals as a WRITE delivers them: Postgres raises the sentence
 * and the cloud client rethrows `error.message`. Matched by SUBSTRING rather
 * than by key, for the same reason stores/board.ts's forceStop branch matches
 * `only the assignee can change status` that way — what the caller receives is
 * the guard's sentence inside whatever the server wrapped it in, and an exact
 * lookup that stops matching fails silently, in English, in a Ukrainian pane.
 * `undefined` means «not one of ours», i.e. show the raw text.
 */
export function assignmentRefusalText(raw: string): string | undefined {
  return Object.entries(ASSIGNMENT_REFUSALS).find(([refusal]) => raw.includes(refusal))?.[1];
}

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
  if (raw.includes('only the workspace owner can change roles')) {
    return 'Хмара відмовила: змінювати ролі може лише власник воркспейсу';
  }
  return raw;
}
