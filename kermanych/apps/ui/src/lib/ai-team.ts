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

import {
  AGENTS,
  DEFAULT_SKILLS,
  DESIGNER_AGENT_ID,
  DESIGN_SAVE_AGENT_ID,
  MINION_AGENT_ID,
  TESTER_AGENT_ID,
  instructionErrors,
  type AgentDef,
  type SkillView,
} from '@kermanych/core';
import type { AiAgent, AiAgentSkill, AiScope, AiSkill } from '@kermanych/cloud';
import type { KIconName } from 'components/kit/KIcon.vue';

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

// ── agents ───────────────────────────────────────────────────────────────────
// «Агенти» is a short list and a page per agent (docs/specs/2026-11-03-ai-team-agent-pages.md).
// The list groups the agents by the stage of work they serve (decision 4) — presentation, so it
// lives here and not in core's AGENTS — and each agent has its mark (decision 6). Every id of
// AGENTS must sit in exactly one group and have a mark, or a new agent drops out of the list.

export type AiTeamAgentGroup = 'work' | 'design' | 'ship' | 'auto';

export const AI_TEAM_AGENT_GROUPS: readonly { key: AiTeamAgentGroup; agents: readonly string[] }[] = [
  { key: 'work', agents: [MINION_AGENT_ID, 'promote'] },
  { key: 'design', agents: [DESIGNER_AGENT_ID, DESIGN_SAVE_AGENT_ID] },
  { key: 'ship', agents: ['review', TESTER_AGENT_ID, 'pull-request', 'commit', 'resolve-conflict'] },
  { key: 'auto', agents: ['finish', 'summary'] },
];

export const AGENT_ICONS: Readonly<Record<string, KIconName>> = {
  [MINION_AGENT_ID]: 'minion',
  promote: 'agentPromote',
  [DESIGNER_AGENT_ID]: 'design',
  [DESIGN_SAVE_AGENT_ID]: 'agentDesignSave',
  review: 'agentReview',
  [TESTER_AGENT_ID]: 'agentTester',
  'pull-request': 'agentPullRequest',
  commit: 'agentCommit',
  'resolve-conflict': 'agentResolveConflict',
  finish: 'agentFinish',
  summary: 'agentSummary',
};

/** The agent a URL segment names (`/ai-team/agents/<id>`), or undefined: the list then shows. */
export function aiTeamAgent(id: unknown): AgentDef | undefined {
  return typeof id === 'string' ? AGENTS.find((a) => a.id === id) : undefined;
}

/** Where an agent's effective text or sequence comes from: an owner's row, or Kermanych's default. */
export type AgentSource = AiScope | 'default';

export interface ResolvedAgent {
  /** The text the launch renders; undefined for an automation. */
  instruction: string | undefined;
  instructionFrom: AgentSource;
  /** The assigned sequence, in delivery order. */
  skills: string[];
  /** The scope whose rows the sequence is; `default` when no scope assigns any. */
  skillsFrom: AgentSource;
}

const SCOPE_RANK: Record<AiScope, number> = { user: 0, project: 1, workspace: 2 };

/**
 * What a launch gives `def`, from the rows the caller read (any mix of scopes). The same answer
 * as the api's SkillsService.instructionFor and assignedFor: the instruction is the most specific
 * scope's row, and that row alone — blank or with broken holes it means the default, not the next
 * scope's row; the sequence is taken whole from the most specific scope with any row for the
 * agent, in the operator's order with the name as the tiebreak.
 */
export function resolveAgent(def: AgentDef, agents: readonly AiAgent[], skills: readonly AiAgentSkill[]): ResolvedAgent {
  const top = agents
    .filter((r) => r.agentId === def.id)
    .sort((a, b) => SCOPE_RANK[a.owner.scope] - SCOPE_RANK[b.owner.scope])[0];
  let instruction = def.instruction;
  let instructionFrom: AgentSource = 'default';
  const text = top?.instruction.trim();
  if (def.instruction && top && text) {
    const { missing, unknown } = instructionErrors(def, text);
    if (missing.length === 0 && unknown.length === 0) {
      instruction = text;
      instructionFrom = top.owner.scope;
    }
  }
  const mine = skills.filter((r) => r.agentId === def.id);
  const winner = mine.reduce<AiScope | undefined>(
    (best, r) => (best === undefined || SCOPE_RANK[r.owner.scope] < SCOPE_RANK[best] ? r.owner.scope : best),
    undefined,
  );
  const sequence = mine
    .filter((r) => r.owner.scope === winner)
    .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName))
    .map((r) => r.skillName);
  return { instruction, instructionFrom, skills: sequence, skillsFrom: winner ?? 'default' };
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
