// apps/ui/src/lib/settings.ts
// The Налаштування screen's registry and its pure logic.
//
// ONE table (`SETTINGS_CATEGORIES`) drives four things: the scope switcher's
// contents, the category rail, the pane heading and the URL segment. Adding a
// category is one row here; the page's `v-if` for it is the only other edit.
// This mirrors lib/management.ts, which does the same for the Менеджмент tab.
//
// The three scopes are NOT cosmetic. They are the three places settings actually
// live in this product, and the design's two-way Проєкт/Застосунок switch would
// have had to lie about one of them: team membership hangs off the WORKSPACE (one
// invitation opens every project in the group — see the workspaces migration), so
// listing «Учасники» under a project would name the wrong owner of that data.
//
// Everything registered below is backed by real data. Most rows carry a read and a
// write; a few — «Гарячі клавіші», «ШІ команда» — are reference panes over something
// the application hard-codes, and say so in the pane itself. Nothing here is a
// placeholder: harness paths, provider API keys, spend caps, a parallel agent limit,
// a context-warning threshold and remappable keys have no storage, no endpoint and
// no column anywhere in the repo, so they get no panel.

import type { AgentDef, AgentKind, EnvEntry, SkillView } from '@kermanych/core';
import type { AgentSkill } from '@kermanych/cloud';

export type SettingsScope = 'project' | 'workspace' | 'app';

export interface SettingsCategory {
  /** URL segment under /settings AND the rail's nav value. */
  key: string;
  scope: SettingsScope;
  label: string;
  /** Second line in the rail — what the category actually contains. */
  sub: string;
  /** The pane's subtitle: why the operator would open this. */
  blurb: string;
  /** Irreversible actions. Renders in the danger colour, sorts last. */
  danger?: boolean;
}

export const SETTINGS_SCOPES: readonly { value: SettingsScope; label: string }[] = [
  { value: 'project', label: 'Проєкт' },
  { value: 'workspace', label: 'Воркспейс' },
  { value: 'app', label: 'Застосунок' },
];

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'project-basics',
    scope: 'project',
    label: 'Основне',
    sub: 'назва, колір, тека',
    blurb: 'Як проєкт називається, у якому воркспейсі живе й де його тека на цій машині.',
  },
  {
    key: 'project-git',
    scope: 'project',
    label: 'Гілки й конвенції',
    sub: 'база, PR і коміти',
    blurb: 'Звідки агент відгалужується і за якими правилами пише коміти та PR.',
  },
  {
    key: 'project-commands',
    scope: 'project',
    label: 'Команди',
    sub: 'прев’ю, файли сесії',
    blurb: 'Що Керманич запускає для прев’ю і що копіює в кожну робочу теку.',
  },
  {
    key: 'project-skills',
    scope: 'project',
    label: 'Бібліотека скілів',
    sub: 'знання для агентів',
    blurb:
      'Тексти, які агент бере сам, коли вважає за потрібне. Скіл із таким же імʼям у репозиторії завжди перемагає.',
  },
  {
    key: 'project-agents',
    scope: 'project',
    label: 'Призначення',
    sub: 'скіли для ролей',
    blurb:
      'Які скіли роль отримує обовʼязково, а не бере за власним рішенням. Змінює лише власник воркспейсу.',
  },
  {
    key: 'project-env',
    scope: 'project',
    label: 'Змінні середовища',
    sub: 'значення й обов’язкові ключі',
    blurb:
      'Значення живуть у файлі .env цієї машини. У хмарі Керманич тримає лише імена ключів.',
  },
  {
    key: 'project-danger',
    scope: 'project',
    label: 'Небезпечна зона',
    sub: 'видалення',
    blurb: 'Дії, які неможливо відкотити з інтерфейсу.',
    danger: true,
  },
  {
    key: 'workspace-basics',
    scope: 'workspace',
    label: 'Основне',
    sub: 'назва, колір',
    blurb: 'Як воркспейс виглядає у списку проєктів. Змінює лише його власник.',
  },
  {
    key: 'workspace-members',
    scope: 'workspace',
    label: 'Учасники',
    sub: 'склад команди',
    blurb: 'Одне запрошення відкриває доступ до всіх проєктів воркспейсу.',
  },
  {
    key: 'workspace-danger',
    scope: 'workspace',
    label: 'Небезпечна зона',
    sub: 'видалення',
    blurb: 'Воркспейс можна видалити лише порожнім — і лише власнику.',
    danger: true,
  },
  {
    key: 'app-general',
    scope: 'app',
    label: 'Загальне',
    sub: 'тема',
    blurb: 'Вигляд застосунку на цій машині. Зберігається тут, не в акаунті.',
  },
  {
    key: 'app-keymap',
    scope: 'app',
    label: 'Гарячі клавіші',
    sub: 'наявні призначення',
    blurb: 'Клавіші зашиті в застосунок — перепризначати їх поки нема де.',
  },
  {
    key: 'app-agents',
    scope: 'app',
    label: 'ШІ команда',
    sub: 'ролі та їхні інструкції',
    blurb:
      'Хто працює в команді Керманича і що саме кожна роль отримує на старті. Тексти зашиті в застосунок — тут їх лише видно.',
  },
  {
    key: 'app-account',
    scope: 'app',
    label: 'Акаунт',
    sub: 'сеанс, план, черга',
    blurb: 'Хто ви в Керманичі, що залишилось у плані провайдера і що не дійшло в хмару.',
  },
];

/** Where a bare /settings lands. */
export const SETTINGS_DEFAULT_SECTION = 'project-basics';

/**
 * The category a URL segment names, or the default. A stale bookmark and a typo
 * are the same case: land on something rather than render an empty pane.
 */
export function settingsSection(key: unknown): SettingsCategory {
  const found = typeof key === 'string' ? SETTINGS_CATEGORIES.find((c) => c.key === key) : undefined;
  // The default is a member of the table, so the non-null assertion cannot be
  // wrong without the table itself being broken.
  return found ?? SETTINGS_CATEGORIES.find((c) => c.key === SETTINGS_DEFAULT_SECTION)!;
}

/** The scope switcher's landing category — the first row of that scope. */
export function settingsScopeEntry(scope: SettingsScope): SettingsCategory {
  return SETTINGS_CATEGORIES.find((c) => c.scope === scope) ?? settingsSection(undefined);
}

const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  session: 'власна сесія',
  procedure: 'процедура',
  automation: 'без ШІ',
};

/**
 * WHAT AN AGENT KIND MEANS FOR AN OPERATOR READING THE CATALOGUE. `kind` describes
 * where the agent runs, it does not switch behaviour (see the note on `AGENTS` in
 * core). The badge must never print the raw English enum, and the full sentence for
 * each kind lives in the pane's lead paragraph rather than in the badge.
 */
export function agentKindLabel(kind: AgentKind): string {
  return AGENT_KIND_LABELS[kind];
}

/**
 * One row of the assignment board: an agent, what this project gave it, and what that
 * costs. `skills` is display data only — the merge below is the sole producer, and the
 * panel adds nothing to it.
 *
 * `bytes` is a LOWER BOUND whenever `unmeasured` is non-empty: those names are delivered
 * from a file in the repository, whose size this process cannot see.
 */
export interface AssignmentRow {
  agent: AgentDef;
  skills: AssignedSkill[];
  bytes: number;
  unmeasured: string[];
}

/** One assigned skill as the board shows it. A `broken` entry carries nothing else. */
export interface AssignedSkill {
  name: string;
  source?: SkillView['source'];
  shadowedByRepo?: string;
  broken?: boolean;
}

/**
 * THE BOARD: a pure merge of four reads — the agent registry, the project's assignments,
 * the RESOLVED library view, and the names the bound repository itself defines.
 *
 * Only instruction-bearing agents get a row. An `automation` agent involves no model at
 * all, so there is no text for an assigned skill to be pasted into; offering the operator
 * a slot there would promise a delivery that cannot happen.
 *
 * BROKEN MEANS ABSENT FROM BOTH LISTS, never from `view` alone. The library and the
 * repository are different places, and the resolver reads either of them for an assigned
 * name (SkillsService.assignedForNames: `if (!hit && !repoPath) missing`). A name the
 * repository alone defines is therefore delivered in full on every launch — calling it
 * «немає скіла» would tell the operator to remove a working assignment, and they would.
 * The reachable path is short: assign a repo-shadowed name, then delete its project row in
 * the library pane. The row leaves `view`; the repository still owns the name.
 *
 * A name in neither list is still `broken` rather than dropped: that row of
 * `project_agent_skills` is live, the launcher reports it as `missing`, and the board is
 * the only surface on which the operator can see it and take it off.
 *
 * `bodyBytes` is keyed by skill name because the byte cost is a property of the LIBRARY,
 * not of the assignment: the same skill on two agents is paid for twice, once per launch.
 */
export function assignmentRows(
  agents: readonly AgentDef[],
  assignments: readonly AgentSkill[],
  view: readonly SkillView[],
  bodyBytes: Readonly<Record<string, number>>,
  repo: Readonly<Record<string, string>>,
): AssignmentRow[] {
  const byName = new Map(view.map((v) => [v.name, v]));
  return agents
    .filter((a) => a.instruction)
    .map((agent) => {
      // The operator's own order, with the name as the tiebreak — the exact comparator
      // SkillsService.assignedFor sorts by, so the board's order is the launch order.
      const mine = assignments
        .filter((r) => r.agentId === agent.id)
        .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
      const unmeasured: string[] = [];
      let bytes = 0;
      const skills = mine.map<AssignedSkill>((r) => {
        const hit = byName.get(r.skillName);
        const repoPath = repo[r.skillName];
        // A broken name contributes no bytes and counts as measured: there is no body to
        // pay for, so the total stays an honest figure rather than an open question.
        if (!hit && !repoPath) return { name: r.skillName, broken: true };
        if (Object.hasOwn(bodyBytes, r.skillName)) bytes += bodyBytes[r.skillName]!;
        else unmeasured.push(r.skillName);
        // Repository-only: there is no library entry to describe it, and `source` would be
        // a guess. The badge reads `shadowedByRepo` first, so the path alone is enough to
        // label it «перекрито репо» — which is exactly what it is.
        if (!hit) return { name: r.skillName, shadowedByRepo: repoPath! };
        return {
          name: hit.name,
          source: hit.source,
          // Spread rather than `shadowedByRepo: hit.shadowedByRepo`: an explicit
          // `undefined` would make the key present, and the broken row is compared as a
          // whole object.
          ...(hit.shadowedByRepo ? { shadowedByRepo: hit.shadowedByRepo } : {}),
        };
      });
      return { agent, skills, bytes, unmeasured };
    });
}

/**
 * WHERE AN ASSIGNED SKILL'S TEXT COMES FROM, as one badge.
 *
 * `shadowedByRepo` is checked BEFORE `source`, and that order is the whole point.
 * `SkillView.source` is `'default' | 'project'` with no repository value, so the endpoint
 * reports a skill the repository provides as `source: 'project'` (SkillsService.view /
 * assignedForNames, `hit?.source ?? "project"`). Reading `source` first would tell the
 * operator the project owns a text the repository actually supplies — and the repository
 * always wins the name.
 */
export type AssignmentBadge = { kind: 'default' | 'project' | 'repo' | 'broken'; label: string };

export function assignmentBadge(skill: AssignedSkill): AssignmentBadge {
  if (skill.broken) return { kind: 'broken', label: 'немає скіла' };
  if (skill.shadowedByRepo) return { kind: 'repo', label: 'перекрито репо' };
  return skill.source === 'default'
    ? { kind: 'default', label: 'дефолт' }
    : { kind: 'project', label: 'проєкт' };
}

/**
 * WHEN AN AGENT'S ASSIGNED BLOCK IS BIG ENOUGH TO SAY SO. Assigned text is pasted into
 * the instruction and is therefore paid for on every one of that agent's turns, unlike a
 * library skill the agent may never take.
 *
 * 8 KiB is roughly two thousand tokens — enough to hold both of Kermanych's own defaults
 * and a project skill or two without a word of complaint, and past it the block is a
 * material share of a short task's budget. It is a warning and nothing else: no write is
 * blocked, because the operator may well mean it.
 */
export const ASSIGNED_BYTES_WARN = 8 * 1024;

/**
 * WHICH KEYS OF A DRAFT DIFFER FROM ITS BASELINE. Drives both the «не збережено»
 * pill and the save bar's count, and it is what the save path consults to decide
 * whether a write is worth making at all.
 *
 * Arrays are compared by their JOINED contents, not by identity: `carryFiles` is
 * rebuilt on every chip edit, so an identity check would report a change the
 * moment the operator opened the field. Everything else in a settings draft is a
 * string or a boolean, so `!==` is exact for it.
 */
export function changedFields<T extends object>(draft: T, base: T): (keyof T)[] {
  const out: (keyof T)[] = [];
  for (const key of Object.keys(draft) as (keyof T)[]) {
    const a = draft[key];
    const b = base[key];
    const same =
      Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
    if (!same) out.push(key);
  }
  return out;
}

/**
 * One row of the env table. `required` mirrors membership of the CLOUD's
 * `projects.env_keys` — the names-only list the team shares — while `value` is
 * this machine's `.env` and never leaves it (Requirement 9).
 */
export interface EnvRow {
  key: string;
  value: string;
  required: boolean;
}

/**
 * The table the operator edits: the bound repo's `.env`, plus a valueless row
 * for every required key the file has no value for.
 *
 * Those placeholder rows are the whole reason this is a union rather than a map
 * over `entries`. The old modal reported a missing required key as a red sentence
 * under a checklist, which named the problem and offered nothing to do about it;
 * a row with the pill already lit and an empty value box is the same fact with
 * the fix attached. File order is preserved — it is the operator's own grouping —
 * and the additions land after it, in the cloud's order.
 */
export function buildEnvRows(entries: readonly EnvEntry[], requiredKeys: readonly string[]): EnvRow[] {
  const required = new Set(requiredKeys);
  const rows: EnvRow[] = entries.map((e) => ({ key: e.key, value: e.value, required: required.has(e.key) }));
  const present = new Set(entries.map((e) => e.key));
  for (const key of requiredKeys) {
    if (!present.has(key)) rows.push({ key, value: '', required: true });
  }
  return rows;
}

/** The required-key NAMES to store in the cloud, in table order and deduped. */
export function envRequiredKeys(rows: readonly EnvRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const key = r.key.trim();
    if (r.required && key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The PUT /projects/:id/env payload for a table against the file it was built
 * from.
 *
 * A row whose value is empty AND whose key is not in the file is a declared
 * requirement, not a variable: writing `KEY=` would hand the agent an empty
 * string where it expects a secret, and the launch would fail further away from
 * the cause. It contributes to `envKeys` (above) and to nothing else.
 *
 * Clearing an EXISTING key's value still writes the empty string, because that
 * is an edit the operator made deliberately on a line they can see.
 */
export function envEdits(
  rows: readonly EnvRow[],
  entries: readonly EnvEntry[],
): { set: Record<string, string>; remove: string[] } {
  const inFile = new Set(entries.map((e) => e.key));
  const set: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    if (r.value === '' && !inFile.has(key)) continue;
    set[key] = r.value;
  }
  const remove = entries.map((e) => e.key).filter((k) => !Object.hasOwn(set, k));
  return { set, remove };
}
