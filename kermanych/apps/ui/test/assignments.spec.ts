import { expect, test } from 'vitest';
import { AGENTS, DEFAULT_SKILLS, type SkillView } from '@kermanych/core';
import type { AgentSkill } from '@kermanych/cloud';
import { ASSIGNED_BYTES_WARN, assignmentBadge, assignmentRows } from '../src/lib/settings';

// The pure half of the assignment board. Four reads meet here — the agent registry, the
// project's assignments, the RESOLVED library view and the names the bound repository itself
// defines — and everything the panel renders per row comes out of this merge, so it is the
// merge that is pinned rather than markup. `{}` for the last argument means «this checkout
// defines no skills of its own», which is the ordinary case.

const A = (skillName: string, position = 0): AgentSkill => ({
  projectId: 'p1',
  agentId: 'review',
  skillName,
  position,
});
const V = (name: string, over: Partial<SkillView> = {}): SkillView => ({
  name,
  description: 'd',
  source: 'project',
  ...over,
});

test('only instruction-bearing agents can be assigned to', () => {
  const rows = assignmentRows(AGENTS, [], [], {}, {});
  expect(rows.map((r) => r.agent.id)).toEqual(['review', 'promote', 'pull-request', 'resolve-conflict']);
});

test('assigned skills come back in position then name order', () => {
  const rows = assignmentRows(
    AGENTS,
    [A('b', 1), A('a', 1), A('zero', 0)],
    [V('a'), V('b'), V('zero')],
    { a: 10, b: 10, zero: 10 },
    {},
  );
  expect(rows[0]!.skills.map((s) => s.name)).toEqual(['zero', 'a', 'b']);
});

test('a name the resolved view does not contain is marked broken, not dropped', () => {
  const rows = assignmentRows(AGENTS, [A('gone')], [], {}, {});
  expect(rows[0]!.skills).toEqual([{ name: 'gone', broken: true }]);
});

// THE FIX. The library and the repository are different places, and the resolver reads
// EITHER of them for an assigned name (SkillsService.assignedForNames). So a name the
// repository alone defines is delivered in full on every launch — and it used to render as
// «немає скіла», which is an instruction to remove a working assignment. The operator path
// is real: assign a repo-shadowed name, then delete its project row in the library pane.
//
// If the `&& !repoPath` half of the broken test is reverted, this fails and the case below
// still passes: absence from the view alone must not be enough.
test('a name only the repository defines is live, not broken', () => {
  const rows = assignmentRows(AGENTS, [A('repo-only')], [], {}, {
    'repo-only': '/repo/.omp/skills/repo-only/SKILL.md',
  });
  const skill = rows[0]!.skills[0]!;
  expect(skill.broken).toBeUndefined();
  expect(skill).toEqual({ name: 'repo-only', shadowedByRepo: '/repo/.omp/skills/repo-only/SKILL.md' });
  // And it must read as the repository's text, not as the project's.
  expect(assignmentBadge(skill)).toEqual({ kind: 'repo', label: 'перекрито репо' });
});

// Its size is unknowable from the renderer — the file is in the checkout, not in the cloud
// row this pane measures. It must not be counted as zero, which would understate the block
// the launch pastes; the row reports it as unmeasured and the total becomes a lower bound.
test('a repository-only name is reported as unmeasured rather than counted as zero', () => {
  const rows = assignmentRows(AGENTS, [A('mine', 0), A('repo-only', 1)], [V('mine')], { mine: 500 }, {
    'repo-only': '/repo/.omp/skills/repo-only/SKILL.md',
  });
  expect(rows[0]!.bytes).toBe(500);
  expect(rows[0]!.unmeasured).toEqual(['repo-only']);
  // A broken name is a different case: there is no body anywhere, so the total is exact.
  const dangling = assignmentRows(AGENTS, [A('gone')], [], {}, {});
  expect(dangling[0]!.unmeasured).toEqual([]);
  expect(dangling[0]!.bytes).toBe(0);
});

// The other half of the same condition: absent from the view AND absent from the repository
// is still broken, and still visible.
test('a name in neither the library nor the repository is broken', () => {
  const rows = assignmentRows(AGENTS, [A('gone')], [V('other')], { other: 10 }, {
    'something-else': '/repo/.omp/skills/something-else/SKILL.md',
  });
  expect(rows[0]!.skills).toEqual([{ name: 'gone', broken: true }]);
  expect(assignmentBadge(rows[0]!.skills[0]!)).toEqual({ kind: 'broken', label: 'немає скіла' });
});

// `constructor` is a LEGAL skill name — lowercase, no separators, so SKILL_NAME_RE and the
// column's identical check constraint both accept it, and the library pane will create and
// assign it. It is also the one Object.prototype member a skill can be named after
// (`toString`, `valueOf`, `__proto__` all carry characters the pattern rejects), so a bare
// `repo[name]` read it back as an inherited function: truthy, so the assignment rendered as a
// LIVE «перекрито репо» row with a stringified function for a path, while the launcher
// reported it `missing`. Reachable in three steps: create a skill called `constructor`, assign
// it, delete its library row.
//
// Reverting the `Object.hasOwn` guard on that read must fail this test.
test('a dangling assignment named constructor is broken, not a repository skill', () => {
  for (const repo of [{}, { 'other-skill': '/repo/.omp/skills/other-skill/SKILL.md' }]) {
    const rows = assignmentRows(AGENTS, [A('constructor')], [], {}, repo);
    expect(rows[0]!.skills).toEqual([{ name: 'constructor', broken: true }]);
    expect(assignmentBadge(rows[0]!.skills[0]!)).toEqual({ kind: 'broken', label: 'немає скіла' });
    // And it is not an open question about the byte total either: there is no body anywhere.
    expect(rows[0]!.unmeasured).toEqual([]);
    expect(rows[0]!.bytes).toBe(0);
  }
  // A repository that really does define it still wins, exactly like any other name.
  const real = assignmentRows(AGENTS, [A('constructor')], [], {}, {
    constructor: '/repo/.omp/skills/constructor/SKILL.md',
  });
  expect(real[0]!.skills).toEqual([
    { name: 'constructor', shadowedByRepo: '/repo/.omp/skills/constructor/SKILL.md' },
  ]);
  expect(real[0]!.unmeasured).toEqual(['constructor']);
});

test('a repo-shadowed skill carries its path, and the byte total sums the bodies', () => {
  const rows = assignmentRows(
    AGENTS,
    [A('x'), A('y')],
    [V('x', { shadowedByRepo: '/repo/.omp/skills/x/SKILL.md' }), V('y', { source: 'default' })],
    { x: 1200, y: 800 },
    {},
  );
  expect(rows[0]!.skills[0]).toMatchObject({ name: 'x', shadowedByRepo: '/repo/.omp/skills/x/SKILL.md' });
  expect(rows[0]!.skills[1]).toMatchObject({ name: 'y', source: 'default' });
  expect(rows[0]!.bytes).toBe(2000);
});

// An assignment belongs to one agent. Rows for another agent must not leak into this one's
// list or into its byte total — the total is what the operator budgets a single launch by.
test('each agent sees only its own assignments, and its own byte total', () => {
  const rows = assignmentRows(
    AGENTS,
    [A('x'), { projectId: 'p1', agentId: 'promote', skillName: 'y', position: 0 }],
    [V('x'), V('y')],
    { x: 100, y: 900 },
    {},
  );
  const review = rows.find((r) => r.agent.id === 'review')!;
  const promote = rows.find((r) => r.agent.id === 'promote')!;
  expect(review.skills.map((s) => s.name)).toEqual(['x']);
  expect(review.bytes).toBe(100);
  expect(promote.skills.map((s) => s.name)).toEqual(['y']);
  expect(promote.bytes).toBe(900);
});

// An assignment aimed at an agent that has no instruction has nowhere to be pasted, so no
// row of the board may claim it — and it must not be silently attributed to another agent.
test('an assignment to an instruction-less agent appears on no row', () => {
  const rows = assignmentRows(
    AGENTS,
    [{ projectId: 'p1', agentId: 'finish', skillName: 'x', position: 0 }],
    [V('x')],
    { x: 500 },
    {},
  );
  expect(rows.flatMap((r) => r.skills)).toEqual([]);
  expect(rows.every((r) => r.bytes === 0)).toBe(true);
});

// THE LOAD-BEARING ONE. `SkillView.source` has no repository value: the endpoint reports a
// skill that exists only as a repository file as `source: 'project'` (SkillsService.view),
// and a truthy `shadowedByRepo` is the ONLY thing that means the repository won the name.
// Reading `source` first would label a repository-provided text as the project's own.
test('the badge keys off shadowedByRepo, never off source', () => {
  expect(assignmentBadge({ name: 'x', source: 'project', shadowedByRepo: '/repo/x/SKILL.md' })).toEqual({
    kind: 'repo',
    label: 'перекрито репо',
  });
  expect(assignmentBadge({ name: 'x', source: 'default', shadowedByRepo: '/repo/x/SKILL.md' })).toEqual({
    kind: 'repo',
    label: 'перекрито репо',
  });
  expect(assignmentBadge({ name: 'x', source: 'default' })).toEqual({ kind: 'default', label: 'дефолт' });
  expect(assignmentBadge({ name: 'x', source: 'project' })).toEqual({ kind: 'project', label: 'проєкт' });
});

// A dangling assignment has no source to report — its badge says what is actually wrong.
test('a broken row gets its own badge rather than a source it does not have', () => {
  expect(assignmentBadge({ name: 'gone', broken: true })).toEqual({ kind: 'broken', label: 'немає скіла' });
});

// The threshold exists to catch a bloated block, not to nag about a normal one: assigning
// both of Kermanych's own defaults must stay under it, or the warning is noise from day one.
test('the byte warning clears both Kermanych defaults assigned at once', () => {
  const total = DEFAULT_SKILLS.reduce((sum, d) => sum + new TextEncoder().encode(d.body).length, 0);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(ASSIGNED_BYTES_WARN);
});
