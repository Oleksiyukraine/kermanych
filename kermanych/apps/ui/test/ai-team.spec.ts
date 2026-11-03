import { describe, expect, it } from 'vitest';
import { MINION_AGENT_ID, agentById } from '@kermanych/core';
import type { AiAgent, AiAgentSkill, AiOwner } from '@kermanych/cloud';
import {
  AI_TEAM_DEFAULT_SECTION,
  AI_TEAM_SECTIONS,
  agentOverrides,
  aiTeamSection,
  importNameProblem,
  resolveAgent,
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

// What an agent runs with, as SkillsService.instructionFor / assignedFor resolve it: the most
// specific owner with a row wins the instruction, and — separately — the whole skill sequence.
// The project tab shows this, so a pre-rescope project row cannot hide behind the workspace's text.
describe('resolveAgent / agentOverrides', () => {
  const def = agentById(MINION_AGENT_ID)!;
  const WS: AiOwner = { scope: 'workspace', id: 'w1' };
  const PR: AiOwner = { scope: 'project', id: 'p1' };
  const ME: AiOwner = { scope: 'user', id: 'u1' };
  const row = (owner: AiOwner, instruction: string, agentId = MINION_AGENT_ID): AiAgent => ({
    id: `${owner.scope}-${agentId}`,
    owner,
    agentId,
    instruction,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  });
  const skill = (owner: AiOwner, skillName: string, position: number, agentId = MINION_AGENT_ID): AiAgentSkill => ({
    owner,
    agentId,
    skillName,
    position,
  });

  it('runs a project row over the workspace one', () => {
    const r = resolveAgent(def, [row(WS, 'Workspace {{task}}'), row(PR, 'Project {{task}}')], []);
    expect(r).toMatchObject({ instruction: 'Project {{task}}', instructionFrom: 'project' });
  });

  it('runs the user row over project and workspace, whatever the read order', () => {
    const r = resolveAgent(def, [row(ME, 'Mine {{task}}'), row(WS, 'Workspace {{task}}'), row(PR, 'Project {{task}}')], []);
    expect(r).toMatchObject({ instruction: 'Mine {{task}}', instructionFrom: 'user' });
  });

  // instructionFor drops a winning row that lost its hole for the DEFAULT, not for the workspace.
  it('falls back to the default, not to the workspace, when the winning row is broken', () => {
    const r = resolveAgent(def, [row(WS, 'Workspace {{task}}'), row(PR, 'Project without the hole')], []);
    expect(r).toMatchObject({ instruction: def.instruction, instructionFrom: 'project' });
  });

  it('takes the whole sequence from the most specific owner that has one', () => {
    const r = resolveAgent(def, [], [skill(WS, 'ws-a', 0), skill(PR, 'pr-b', 1), skill(PR, 'pr-a', 0), skill(WS, 'ws-b', 1)]);
    expect(r).toMatchObject({ skills: ['pr-a', 'pr-b'], skillsFrom: 'project' });
  });

  it('runs the default with no sequence when no owner has a row', () => {
    const r = resolveAgent(def, [row(PR, 'Other {{diff}}', 'review')], [skill(PR, 'x', 0, 'review')]);
    expect(r).toEqual({ instruction: def.instruction, skills: [] });
  });

  it('agentOverrides lists the user and project rows that beat the workspace, one entry per owner and agent', () => {
    expect(
      agentOverrides(
        [row(WS, 'Workspace {{task}}'), row(PR, 'Project {{task}}'), row(ME, 'Mine {{diff}}', 'review')],
        [skill(PR, 'b', 1), skill(PR, 'a', 0), skill(PR, 'c', 0, 'plan'), skill(WS, 'ws', 0)],
      ),
    ).toEqual([
      { owner: ME, agentId: 'review', instruction: 'Mine {{diff}}', skills: [] },
      { owner: PR, agentId: MINION_AGENT_ID, instruction: 'Project {{task}}', skills: ['a', 'b'] },
      { owner: PR, agentId: 'plan', skills: ['c'] },
    ]);
  });
});
