// Who a task belongs to, as pure functions. Same reason as lib/scope.ts: apps/ui has no
// component tests, so the part that can be WRONG — which of a member's three possible names
// wins, and what a task with an unresolvable assignee shows — lives here and is unit-tested,
// while the .vue files only place it on screen.
import type { WorkspaceMember } from '@kermanych/cloud';

// One fallback chain for every surface that names a person: the «Виконавці» filter, the
// editor's picker and the avatar on each card. If they diverged, the same teammate would
// appear under two different names in two controls on one screen.
//
// `userId` last is a raw uuid, and deliberately so — it is the only thing left when the
// profile row is not readable, and a blank where a name belongs would read as «нікому».
export function handleOf(m: WorkspaceMember): string {
  return m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId;
}

// What an avatar needs, and nothing else. `avatarUrl` is optional rather than
// `string | undefined` because exactOptionalPropertyTypes is on: the absent key is the
// «no picture» state, and `{ avatarUrl: undefined }` would not be assignable.
export type Assignee = { name: string; avatarUrl?: string };

// `null` means «не призначено» — the state the board draws as an empty dashed frame.
//
// The other absence is different and must not collapse into it: a task that IS claimed by
// someone the roster cannot resolve (the workspace membership read failed, or the project's
// cloud row is not held). That returns the raw id as the name, exactly like `handleOf`'s own
// last resort, so an assigned card never renders as unassigned.
export function resolveAssignee(
  assigneeId: string | null | undefined,
  roster: WorkspaceMember[],
): Assignee | null {
  if (!assigneeId) return null;
  const member = roster.find((m) => m.userId === assigneeId);
  if (!member) return { name: assigneeId };
  const avatarUrl = member.profile?.avatarUrl;
  return { name: handleOf(member), ...(avatarUrl ? { avatarUrl } : {}) };
}
