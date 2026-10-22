import { describe, expect, it } from 'vitest';
import {
  AI_TEAM_DEFAULT_SECTION,
  AI_TEAM_SECTIONS,
  aiTeamSection,
  importNameProblem,
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
