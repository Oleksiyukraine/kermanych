import { describe, expect, it } from 'vitest';
import {
  AI_TEAM_DEFAULT_SECTION,
  AI_TEAM_SECTIONS,
  aiTeamSection,
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
