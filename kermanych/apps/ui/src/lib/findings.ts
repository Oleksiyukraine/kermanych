// «Знахідки» filing dialog: the Jira issue type it picks before the operator edits anything
// (docs/specs/2026-10-13-agent-findings.md, Decision 8), and the board card it files. Pure, so
// the dialog stays wiring.
import { findingIssueTypeName, type AgentFinding, type FindingKind } from '@kermanych/core';
import type { CloudProject, TaskInsert } from '@kermanych/cloud';

type IssueType = { id: string; name: string; subtask: boolean };

/**
 * The Jira issue type a finding is filed as: the one named `Bug` / `Task` for its kind
 * (case-insensitive — sites rename casing, not meaning), else the first non-subtask type the
 * site offers. A finding is never a subtask: it has no parent to hang from.
 */
export function pickFindingIssueType(types: readonly IssueType[], kind: FindingKind): string | undefined {
  const candidates = types.filter((t) => !t.subtask);
  const wanted = findingIssueTypeName(kind).toLowerCase();
  return (candidates.find((t) => t.name.toLowerCase() === wanted) ?? candidates[0])?.id;
}

/**
 * The board card a finding becomes. Like the board's own «Нова задача»: the target project's
 * default model and effort, a worktree, no platform; a bug or a vulnerability is a fix, the rest
 * is new work. `findingKind` is always set — it is how a finding-born card is counted later
 * (docs/specs/2026-10-23-minion-auto-run.md, decision 4) — and `autoRun` is the dialog's
 * «Дозволити автовиконання», off unless the operator checks it.
 */
export function findingTaskInsert(
  f: Pick<AgentFinding, 'kind'>,
  dest: Pick<CloudProject, 'id' | 'defaultModel' | 'defaultEffort'>,
  fields: { title: string; description: string; assigneeId: string; autoRun: boolean },
): TaskInsert {
  return {
    projectId: dest.id,
    title: fields.title.trim(),
    description: fields.description,
    prefix: f.kind === 'bug' || f.kind === 'security' ? 'fix' : 'feature',
    worktree: true,
    ...(dest.defaultModel ? { model: dest.defaultModel } : {}),
    ...(dest.defaultEffort ? { effort: dest.defaultEffort } : {}),
    ...(fields.assigneeId ? { assigneeId: fields.assigneeId } : {}),
    autoRun: fields.autoRun,
    findingKind: f.kind,
  };
}
