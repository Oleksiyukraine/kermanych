// The one-time move of pre-cutover local backlog rows onto the board. Before this change a
// «В беклог» task was a local SQLite session and nothing else, so every machine holds a few
// that the team has never seen. This decides what to publish and what cannot be published;
// the caller performs the writes.
import type { Session } from '@kermanych/core';
import type { TaskInsert } from '@kermanych/cloud';

export type BacklogPublication = {
  sessionId: string;
  insert: TaskInsert & { id: string; assigneeId: string };
};

export type BacklogPlan = { publish: BacklogPublication[]; stranded: Session[] };

// `id` is the LOCAL session id, which is already a randomUUID (registry.createSession), so
// re-running the pass hits the tasks primary key instead of minting a duplicate card — the
// caller reads `duplicate key` as «already published» and deletes the local row.
export function planBacklogPublication(
  sessions: Session[],
  cloudProjectIds: Set<string>,
  assigneeId: string,
): BacklogPlan {
  const plan: BacklogPlan = { publish: [], stranded: [] };
  for (const s of sessions) {
    if (s.archived || s.kind !== 'task' || s.status !== 'backlog') continue;
    if (!cloudProjectIds.has(s.projectId)) {
      plan.stranded.push(s);
      continue;
    }
    plan.publish.push({
      sessionId: s.id,
      insert: {
        id: s.id,
        projectId: s.projectId,
        title: s.name,
        description: s.task,
        ...(s.model ? { model: s.model } : {}),
        ...(s.prefix ? { prefix: s.prefix } : {}),
        ...(s.platform ? { platform: s.platform } : {}),
        worktree: s.worktree,
        ...(s.worktree && s.baseBranch ? { branch: s.baseBranch } : {}),
        assigneeId,
      },
    });
  }
  return plan;
}
