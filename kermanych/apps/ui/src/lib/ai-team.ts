// apps/ui/src/lib/ai-team.ts
// The «ШІ-команда» screen's registry and its pure logic.
//
// «ШІ-команда» used to be three rows inside Налаштування (project scope). It is a screen of
// its own now, promoted into the top nav beside Менеджмент, because it is a workbench the
// operator reads and edits together — not a setting they flip once — and it carries the same
// two-column shape Налаштування does: a rail of sections on the left, the section's editor on
// the right.
//
// ONE table (`AI_TEAM_SECTIONS`) drives the rail, the pane heading and the URL segment.
// Adding a section is one row here plus the page's `v-if` for it. This mirrors lib/settings.ts.
//
// The rail groups the sections under captions, and the caption — not the row — carries the
// noun the operator thinks in:
//   Автоматизація — what runs WITHOUT the model choosing to: an agent's launch instruction
//                   (Агенти) and the rules that fire on a pattern (Тригери).
//   Навички       — the library both of the above draw skills from (Навички).
//   Довідка       — read-only reference over what the app hard-codes: the chat command
//                   catalogue (Хелпери), which has nothing to own, edit or delete.

import { DEFAULT_SKILLS, type SkillView } from '@kermanych/core';
import type { AiScope, AiSkill } from '@kermanych/cloud';

export type AiTeamGroup = 'automation' | 'skills' | 'reference';

export interface AiTeamSection {
  /** URL segment under /ai-team AND the rail's nav value. */
  key: string;
  /** The rail caption this section prints under. */
  group: AiTeamGroup;
}

// The rail label, its second line and the pane subtitle are NOT stored here: the registry is
// pure structure, and every visible string is a key derived from `key`
// (`aiTeam.sections.<key>.{label,sub,blurb}`) resolved at the callsite via t(). The group
// caption is `aiTeam.groups.<group>`.
export const AI_TEAM_GROUPS: readonly AiTeamGroup[] = ['automation', 'skills', 'reference'];

export const AI_TEAM_SECTIONS: readonly AiTeamSection[] = [
  // Агенти first: an agent's instruction is what a trigger interrupts and what an assigned
  // skill is pasted into, so it is the thing the other two modify.
  { key: 'agents', group: 'automation' },
  { key: 'triggers', group: 'automation' },
  { key: 'skills', group: 'skills' },
  // Хелпери are the odd row out: a compile-time catalogue, not a per-owner row, so the panel
  // takes no owner and the section can only be read. It sits under its own caption for that
  // reason — grouping it with the editable automation would blur read-only into editable.
  { key: 'helpers', group: 'reference' },
];

/** Where a bare /ai-team lands. */
export const AI_TEAM_DEFAULT_SECTION = 'agents';

/**
 * The section a URL segment names, or the default. A stale bookmark and a typo are the same
 * case: land on something rather than render an empty pane.
 */
export function aiTeamSection(key: unknown): AiTeamSection {
  return AI_TEAM_SECTIONS.find((s) => s.key === key) ?? AI_TEAM_SECTIONS[0]!;
}

// ── scope ────────────────────────────────────────────────────────────────────
// The owner axis, top of the pane: which of the three the operator is editing. `user` is the
// signed-in operator's private overlay, `project` this project's specifics, `workspace` the
// group's shared defaults. Order is the precedence order the launch resolver uses, most
// specific first — the switcher reads left-to-right the way an override is read.

export const AI_TEAM_SCOPES: readonly AiScope[] = ['user', 'project', 'workspace'];

/**
 * The resolved library view for an owner that has NO checkout (workspace or user): the
 * compile-time defaults underneath, the owner's own rows on top, a disabled row removing the
 * default that shares its name. There is no repository shadow here — only a project has a
 * checkout, and the project scope reads that resolved view from the api instead. Mirrors the
 * api's resolveSkills so the panel shows what a launch at this scope would resolve to.
 */
export function ownerLibraryView(rows: readonly AiSkill[]): SkillView[] {
  const out = new Map<string, SkillView>();
  for (const d of DEFAULT_SKILLS) out.set(d.name, { name: d.name, description: d.description, source: 'default' });
  for (const r of rows) {
    if (!r.enabled) {
      out.delete(r.name);
      continue;
    }
    out.set(r.name, { name: r.name, description: r.description, source: 'project' });
  }
  return [...out.values()].filter((s) => s.description.trim() !== '');
}

/**
 * WHAT STANDS IN THE WAY OF SAVING AN IMPORTED SKILL under `name` at `scope` (spec
 * 2026-10-22-skill-import, decision 6). Two refusals and two warnings, in this order:
 *
 * - `exists`: the owner already has a row by that name. An import never overwrites it.
 * - `repo` (project scope): the bound checkout's standard skill folders own the name, so the
 *   copy would be shadowed and never delivered.
 * - `default`: the name is one of Kermanych's defaults. Allowed — that is how an override works.
 * - `workspace` (project scope): the project's workspace has a skill by that name. Allowed, same.
 *
 * The name's own legality (SKILL_NAME_RE) is the editor's ordinary check and is not repeated.
 */
export type ImportNameProblem = { error?: 'exists' | 'repo'; warn?: 'default' | 'workspace' };

export function importNameProblem(
  name: string,
  ctx: {
    scope: AiScope;
    // The owner's own row names, enabled or not: a tombstone is a row too, and upserting over it
    // would silently switch the default back on under the imported text.
    stored: readonly string[];
    // The project's workspace row names (enabled ones); ignored outside project scope.
    workspace: readonly string[];
    // The checkout's standard skill folders, by name; ignored outside project scope.
    repo: Readonly<Record<string, unknown>>;
  },
): ImportNameProblem {
  if (ctx.stored.includes(name)) return { error: 'exists' };
  const project = ctx.scope === 'project';
  if (project && Object.hasOwn(ctx.repo, name)) return { error: 'repo' };
  if (DEFAULT_SKILLS.some((d) => d.name === name)) return { warn: 'default' };
  if (project && ctx.workspace.includes(name)) return { warn: 'workspace' };
  return {};
}
