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

import { DEFAULT_SKILLS, effectiveInstruction, type AgentDef, type SkillView } from '@kermanych/core';
import type { AiAgent, AiAgentSkill, AiOwner, AiScope, AiSkill } from '@kermanych/cloud';

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
    out.set(r.name, { name: r.name, description: r.description, source: r.owner.scope });
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

// ── agent overrides ──────────────────────────────────────────────────────────
// Agents are edited at workspace scope only, but a launch still reads every owner a session sees
// and takes an agent's instruction — and, separately, its skill sequence — WHOLE from the most
// specific owner that has a row (SkillsService.instructionFor / assignedFor). A project or user
// row (a `project_agents` row the 20260908 rescope moved in, or one saved before the editor became
// workspace-only) therefore silently beats the workspace. These two say what an agent actually
// runs with, and which rows below the workspace decide it.

const SCOPE_RANK: Record<AiScope, number> = { user: 0, project: 1, workspace: 2 };

export type ResolvedAgent = {
  /** The template a launch renders: the winning row's text, or the default when it is blank or broken. */
  instruction: string;
  /** The owner scope whose row won the instruction; absent when no owner has one. */
  instructionFrom?: AiScope;
  /** The skill sequence, in delivery order. */
  skills: string[];
  /** The owner scope the sequence was taken from; absent when no owner has one. */
  skillsFrom?: AiScope;
};

/**
 * One agent as a launch resolves it from the rows of every owner it reads. A broken or blank
 * winning row does NOT fall through to the next owner: instructionFor drops it for the
 * compile-time default, so this does too.
 */
export function resolveAgent(
  def: AgentDef,
  agents: readonly AiAgent[],
  assignments: readonly AiAgentSkill[],
): ResolvedAgent {
  const top = agents
    .filter((r) => r.agentId === def.id)
    .sort((a, b) => SCOPE_RANK[a.owner.scope] - SCOPE_RANK[b.owner.scope])[0];
  const mine = assignments.filter((r) => r.agentId === def.id);
  const skillsFrom = mine.reduce<AiScope | undefined>(
    (best, r) => (best === undefined || SCOPE_RANK[r.owner.scope] < SCOPE_RANK[best] ? r.owner.scope : best),
    undefined,
  );
  return {
    instruction: effectiveInstruction(def, top?.instruction) ?? '',
    ...(top ? { instructionFrom: top.owner.scope } : {}),
    skills: mine
      .filter((r) => r.owner.scope === skillsFrom)
      .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName))
      .map((r) => r.skillName),
    ...(skillsFrom ? { skillsFrom } : {}),
  };
}

/** An owner's own instruction and/or sequence for one agent, which beats the workspace's. */
export type AgentOverride = { owner: AiOwner; agentId: string; instruction?: string; skills: string[] };

/**
 * The user and project rows among `agents` / `assignments`, one entry per owner and agent, most
 * specific owner first, then by agent id. Workspace rows are the base the editor writes, not an
 * override, and are left out.
 */
export function agentOverrides(agents: readonly AiAgent[], assignments: readonly AiAgentSkill[]): AgentOverride[] {
  const byKey = new Map<string, AgentOverride>();
  const entry = (owner: AiOwner, agentId: string): AgentOverride => {
    const key = `${owner.scope}:${owner.id}:${agentId}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { owner, agentId, skills: [] }));
    return e;
  };
  for (const r of agents) if (r.owner.scope !== 'workspace') entry(r.owner, r.agentId).instruction = r.instruction;
  const sorted = [...assignments].sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
  for (const r of sorted) if (r.owner.scope !== 'workspace') entry(r.owner, r.agentId).skills.push(r.skillName);
  return [...byKey.values()].sort(
    (a, b) => SCOPE_RANK[a.owner.scope] - SCOPE_RANK[b.owner.scope] || a.agentId.localeCompare(b.agentId),
  );
}
