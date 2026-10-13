// «Знахідки» filing dialog: the Jira issue type it picks before the operator edits anything
// (docs/specs/2026-10-13-agent-findings.md, Decision 8). Pure, so the dialog stays wiring.
import { findingIssueTypeName, type FindingKind } from '@kermanych/core';

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
