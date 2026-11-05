import { describe, expect, it } from 'vitest';
import { AGENTS, DEFAULT_SKILLS } from '@kermanych/core';
import type { AiAgent, AiAgentSkill, AiOwner, AiSkill } from '@kermanych/cloud';
import {
  AGENT_ICONS,
  AI_TEAM_AGENT_GROUPS,
  AI_TEAM_DEFAULT_SECTION,
  AI_TEAM_SECTIONS,
  aiTeamAgent,
  aiTeamSection,
  blanksDefaultSkill,
  importNameProblem,
  resolveAgent,
  skillEditorDraft,
} from '../src/lib/ai-team';

// The pure half of the «ШІ-команда» screen: the rail registry. The page cannot restate any of
// this — which section a URL resolves to, and that the rail can print each group's caption once
// by walking the table in order.

describe('aiTeamSection', () => {
  it('resolves a known key', () => {
    expect(aiTeamSection('triggers').key).toBe('triggers');
  });

  // A stale bookmark, a hand-typed URL and a bare /ai-team are the same case: land on something
  // rather than render an empty pane — and the default is Агенти, the section the other two edit.
  it('falls back to the default for missing, unknown and non-string keys', () => {
    for (const bad of [undefined, null, '', 'nope', 42, ['agents']]) {
      expect(aiTeamSection(bad).key).toBe(AI_TEAM_DEFAULT_SECTION);
    }
    expect(AI_TEAM_DEFAULT_SECTION).toBe('agents');
  });
});

describe('AI_TEAM_SECTIONS', () => {
  // The key is a URL segment and the rail's nav value at once; a duplicate would make one of
  // the two sections unreachable.
  it('has unique keys', () => {
    const keys = AI_TEAM_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The rail's three captions: Автоматизація over Агенти + Тригери, Навички over the library,
  // Довідка over the read-only Хелпери catalogue. Agents first, because its instruction is what
  // a trigger interrupts and what an assigned skill is pasted into; Хелпери last, because it is
  // a compile-time reference with no owner to configure.
  it('groups the sections under their captions, in order', () => {
    expect(AI_TEAM_SECTIONS.map((s) => [s.group, s.key])).toEqual([
      ['automation', 'agents'],
      ['automation', 'triggers'],
      ['skills', 'skills'],
      ['reference', 'helpers'],
    ]);
  });

  // The rail prints a caption whenever the group changes while walking the table, so a group
  // split across the table would print its caption twice. Each group must be one contiguous run.
  it('keeps each group contiguous', () => {
    const groups = AI_TEAM_SECTIONS.map((s) => s.group);
    const firstSeen = [...new Set(groups)];
    expect(groups).toEqual(firstSeen.flatMap((g) => groups.filter((x) => x === g)));
  });
});

// An imported skill's name, checked before it can be saved (spec 2026-10-22-skill-import,
// decision 6). A refusal protects a row or a delivery; a warning only says what gets overridden.
describe('importNameProblem', () => {
  const base = { scope: 'project' as const, stored: [] as string[], workspace: [] as string[], repo: {} };

  it('refuses a name the owner already has, a switched-off default included', () => {
    expect(importNameProblem('mine', { ...base, stored: ['mine'] })).toEqual({ error: 'exists' });
    expect(importNameProblem('task-spec', { ...base, stored: ['task-spec'] })).toEqual({ error: 'exists' });
  });

  it('refuses, at project scope, a name the checkout owns: that copy would never be delivered', () => {
    const repo = { mine: { path: '/r/.agents/skills/mine/SKILL.md', description: '' } };
    expect(importNameProblem('mine', { ...base, repo })).toEqual({ error: 'repo' });
    // No other owner has a checkout, so the map is not consulted there.
    expect(importNameProblem('mine', { ...base, scope: 'user', repo })).toEqual({});
  });

  it('allows overriding a default or the workspace, with a warning', () => {
    expect(importNameProblem('task-spec', base)).toEqual({ warn: 'default' });
    expect(importNameProblem('house', { ...base, workspace: ['house'] })).toEqual({ warn: 'workspace' });
    // The workspace's names matter only to a project inheriting from it.
    expect(importNameProblem('house', { ...base, scope: 'user', workspace: ['house'] })).toEqual({});
  });

  it('passes a fresh name', () => {
    expect(importNameProblem('humanizer', base)).toEqual({});
  });

  // `constructor` is a legal skill name and an Object.prototype member: a bare `in` would find it.
  it('does not mistake an inherited property for a repository skill', () => {
    expect(importNameProblem('constructor', base)).toEqual({});
  });
});

// «Редагувати» on a Kermanych default at workspace scope. The editor used to open such a default
// on an empty body when the workspace had no row for it, so a description-only edit saved an
// empty override that every session in the workspace then got instead of the default.
describe('skillEditorDraft and blanksDefaultSkill', () => {
  const ws = { scope: 'workspace' as const, id: 'w' };
  const stored = (name: string, body: string, enabled = true): AiSkill => ({
    id: name,
    owner: ws,
    name,
    description: 'd',
    body,
    enabled,
    createdAt: '',
    updatedAt: '',
  });
  const taskSpec = DEFAULT_SKILLS.find((d) => d.name === 'task-spec')!;

  it('opens a default the workspace has not overridden on its own text, which is what gets saved', () => {
    const draft = skillEditorDraft('task-spec', [stored('house', 'H')]);
    expect(taskSpec.body.trim()).not.toBe('');
    expect(draft).toEqual({ body: taskSpec.body, enabled: true });
    // Saved untouched, the body goes through with no question.
    expect(blanksDefaultSkill('task-spec', draft.body)).toBe(false);
  });

  it('opens on the stored row once the workspace has one', () => {
    expect(skillEditorDraft('task-spec', [stored('task-spec', 'Ours')])).toEqual({ body: 'Ours', enabled: true });
    expect(skillEditorDraft('house', [stored('house', 'H', false)])).toEqual({ body: 'H', enabled: false });
  });

  it('asks before an empty body replaces a default, and only then', () => {
    for (const body of ['', '  \n ']) expect(blanksDefaultSkill('task-spec', body)).toBe(true);
    expect(blanksDefaultSkill('house', '')).toBe(false);
  });
});

// «Агенти» as a list and a page per agent (docs/specs/2026-11-03-ai-team-agent-pages.md). The
// list is built from the group table, so an agent missing from it is an agent the operator can
// never open.
describe('AI_TEAM_AGENT_GROUPS and AGENT_ICONS', () => {
  it('list every agent exactly once, each with a mark', () => {
    const listed = AI_TEAM_AGENT_GROUPS.flatMap((g) => g.agents);
    expect([...listed].sort()).toEqual(AGENTS.map((a) => a.id).sort());
    expect(AGENTS.filter((a) => !AGENT_ICONS[a.id]).map((a) => a.id)).toEqual([]);
  });
});

describe('aiTeamAgent', () => {
  it('resolves an agent id and nothing else', () => {
    expect(aiTeamAgent('review')?.id).toBe('review');
    for (const bad of [undefined, '', 'nope', ['review'], 42]) expect(aiTeamAgent(bad)).toBeUndefined();
  });
});

// What a project's read-only agent page shows must be what the launch gives the agent
// (SkillsService.instructionFor / assignedFor): the most specific scope wins, and only it.
describe('resolveAgent', () => {
  const review = AGENTS.find((a) => a.id === 'review')!;
  const finish = AGENTS.find((a) => a.id === 'finish')!;
  const ws = { scope: 'workspace' as const, id: 'w' };
  const pr = { scope: 'project' as const, id: 'p' };
  const row = (owner: AiOwner, instruction: string, agentId = 'review'): AiAgent => ({
    id: owner.id + agentId,
    owner,
    agentId,
    instruction,
    createdAt: '',
    updatedAt: '',
  });
  const valid = (tag: string) => `${tag} {{task}} {{base}} {{branch}} {{diff}}`;
  const skill = (owner: AiOwner, skillName: string, position: number, agentId = 'review'): AiAgentSkill => ({
    owner,
    agentId,
    skillName,
    position,
  });

  it('falls back to the default with no rows', () => {
    expect(resolveAgent(review, [], [])).toEqual({
      instruction: review.instruction,
      instructionFrom: 'default',
      skills: [],
      skillsFrom: 'default',
    });
  });

  it('takes the project row over the workspace row', () => {
    const r = resolveAgent(review, [row(ws, valid('W')), row(pr, valid('P'))], []);
    expect(r.instruction).toBe(valid('P'));
    expect(r.instructionFrom).toBe('project');
    expect(resolveAgent(review, [row(ws, valid('W'))], []).instructionFrom).toBe('workspace');
  });

  // instructionFor reads the top row alone: a broken or blank one means the default, it does not
  // hand over to the workspace's text.
  it('treats a broken or blank top row as the default, not as the next scope', () => {
    for (const bad of ['missing holes', '   ', valid('P') + ' {{nope}}']) {
      const r = resolveAgent(review, [row(ws, valid('W')), row(pr, bad)], []);
      expect(r).toMatchObject({ instruction: review.instruction, instructionFrom: 'default' });
    }
  });

  it('ignores rows of other agents', () => {
    expect(resolveAgent(review, [row(ws, 'x', 'promote')], [skill(ws, 's', 0, 'promote')])).toMatchObject({
      instructionFrom: 'default',
      skills: [],
    });
  });

  it('takes the sequence whole from the most specific scope, in order with the name as tiebreak', () => {
    const r = resolveAgent(review, [], [skill(ws, 'w1', 0), skill(pr, 'b', 1), skill(pr, 'z', 0), skill(pr, 'a', 1)]);
    expect(r.skills).toEqual(['z', 'a', 'b']);
    expect(r.skillsFrom).toBe('project');
  });

  it('has no instruction for an automation, whatever the rows say', () => {
    expect(resolveAgent(finish, [row(ws, 'text', 'finish')], [])).toMatchObject({
      instruction: undefined,
      instructionFrom: 'default',
    });
  });
});
