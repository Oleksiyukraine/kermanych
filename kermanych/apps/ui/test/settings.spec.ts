import { describe, expect, it } from 'vitest';
import type { EnvEntry } from '@kermanych/core';
import {
  buildEnvRows,
  changedFields,
  envEdits,
  envKeysChange,
  envRequiredKeys,
  setEnvValue,
  settingsScopeEntry,
  settingsSection,
  SETTINGS_CATEGORIES,
  SETTINGS_DEFAULT_SECTION,
  type EnvRow,
} from '../src/lib/settings';

// The pure half of the Налаштування screen. Everything asserted here is a
// contract the pane cannot restate: which category a URL resolves to, when the
// save bar lights up, and — the load-bearing one — exactly what a PUT
// /projects/:id/env carries after the operator has edited the table.

describe('settingsSection', () => {
  it('resolves a known key', () => {
    expect(settingsSection('workspace-members').key).toBe('workspace-members');
  });

  // A stale bookmark, a hand-typed URL and a bare /settings are the same case:
  // land on something rather than render an empty pane.
  it('falls back to the default for missing, unknown and non-string keys', () => {
    for (const bad of [undefined, null, '', 'nope', 42, ['project-basics']]) {
      expect(settingsSection(bad).key).toBe(SETTINGS_DEFAULT_SECTION);
    }
  });
});

describe('settingsScopeEntry', () => {
  it('lands on the first category of the scope', () => {
    expect(settingsScopeEntry('project').key).toBe('project-basics');
    expect(settingsScopeEntry('workspace').key).toBe('workspace-basics');
    expect(settingsScopeEntry('app').key).toBe('app-general');
  });
});

describe('SETTINGS_CATEGORIES', () => {
  // The key is a URL segment and the rail's nav value at once; a duplicate would
  // make one of the two categories unreachable.
  it('has unique keys', () => {
    const keys = SETTINGS_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The rail groups by scope without sorting, so a scope split across the table
  // would render its categories in two blocks.
  it('keeps each scope contiguous', () => {
    const scopes = SETTINGS_CATEGORIES.map((c) => c.scope);
    const firstSeen = [...new Set(scopes)];
    expect(scopes).toEqual(firstSeen.flatMap((s) => scopes.filter((x) => x === s)));
  });

  // «ШІ-команда» used to be three rows here (project-agents / project-triggers /
  // project-skills). It is its own top-nav screen now (lib/ai-team.ts, pages/AiTeamPage.vue),
  // so the settings registry must not carry them any more — a stale bookmark for one lands on
  // the default like any other typo.
  it('no longer carries the AI-team rows, which moved to their own screen', () => {
    const keys = SETTINGS_CATEGORIES.map((c) => c.key);
    for (const gone of ['project-agents', 'project-triggers', 'project-skills']) {
      expect(keys).not.toContain(gone);
      expect(settingsSection(gone).key).toBe(SETTINGS_DEFAULT_SECTION);
    }
  });

  // The agent catalogue used to be an APP pane over `AGENTS`, on the grounds that the
  // registry is a compile-time constant. An agent's instruction and its skills are now
  // per-project cloud rows, so there is nothing app-wide left to show and no app-scoped
  // row to reach: the whole section is gone, not merely relabelled.
  it('has no app-scoped agents section', () => {
    expect(SETTINGS_CATEGORIES.some((c) => c.key === 'app-agents')).toBe(false);
    // A stale /settings/app-agents bookmark is a typo like any other: it lands on the default.
    expect(settingsSection('app-agents').key).toBe(SETTINGS_DEFAULT_SECTION);
  });

  // Хелпери are baked into the app — `DEFAULT_HELPERS` is a compile-time constant and the
  // pane is read-only — so they stay at the app scope now that the agents left it.
  it('carries the helper catalogue at the app scope', () => {
    const helpers = settingsSection('app-helpers');
    expect(helpers.key).toBe('app-helpers');
    expect(helpers.scope).toBe('app');
  });

  // The default launch model is per-project cloud config, written through the same projects
  // patch as branches and conventions, so the pane lives at the project scope.
  it('carries the launch defaults at the project scope', () => {
    const defaults = settingsSection('project-defaults');
    expect(defaults.key).toBe('project-defaults');
    expect(defaults.scope).toBe('project');
  });
});

describe('changedFields', () => {
  it('reports only the keys that differ', () => {
    expect(changedFields({ a: '1', b: 'x' }, { a: '1', b: 'y' })).toEqual(['b']);
  });

  // `carryFiles` is rebuilt on every chip edit, so an identity comparison would
  // report a change the moment the field was touched.
  it('compares arrays by contents, not identity', () => {
    expect(changedFields({ files: ['.env'] }, { files: ['.env'] })).toEqual([]);
    expect(changedFields({ files: ['.env'] }, { files: ['.env', 'a.md'] })).toEqual(['files']);
    expect(changedFields({ files: ['a', 'b'] }, { files: ['b', 'a'] })).toEqual(['files']);
  });

  it('treats an emptied string as a change, which is how a field gets cleared', () => {
    expect(changedFields({ conventions: '' }, { conventions: 'squash' })).toEqual(['conventions']);
  });
});

const FILE: EnvEntry[] = [
  { key: 'DATABASE_URL', value: 'postgres://localhost/k' },
  { key: 'LOG_LEVEL', value: 'debug' },
];

describe('buildEnvRows', () => {
  it('keeps file order and flags the required keys', () => {
    expect(buildEnvRows(FILE, ['LOG_LEVEL'])).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://localhost/k', required: false },
      { key: 'LOG_LEVEL', value: 'debug', required: true },
    ]);
  });

  // The whole reason this is a union: a required key the file has no value for
  // must appear as an editable row, not as a red sentence somewhere below.
  it('appends a valueless row for a required key the file lacks', () => {
    expect(buildEnvRows(FILE, ['GITHUB_TOKEN'])).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://localhost/k', required: false },
      { key: 'LOG_LEVEL', value: 'debug', required: false },
      { key: 'GITHUB_TOKEN', value: '', required: true },
    ]);
  });

  it('never duplicates a required key that is already in the file', () => {
    const rows = buildEnvRows(FILE, ['LOG_LEVEL', 'LOG_LEVEL']);
    expect(rows.filter((r) => r.key === 'LOG_LEVEL')).toHaveLength(1);
  });
});

describe('envRequiredKeys', () => {
  it('collects flagged keys in table order, trimmed and deduped', () => {
    const rows: EnvRow[] = [
      { key: ' B ', value: '', required: true },
      { key: 'A', value: 'x', required: true },
      { key: 'B', value: 'y', required: true },
      { key: 'C', value: 'z', required: false },
      { key: '  ', value: 'q', required: true },
    ];
    expect(envRequiredKeys(rows)).toEqual(['B', 'A']);
  });
});

describe('envKeysChange', () => {
  // The bug this guards: the env table is loaded for the env section alone, so a save
  // made in «Основне» used to compute an empty required list and patch the cloud's
  // shared checklist away as a side effect of renaming the project.
  it('says nothing about the keys while the file has not been read', () => {
    expect(envKeysChange(false, [], ['GITHUB_TOKEN'])).toBeNull();
  });

  it('sends the emptied list once the table is real, because clearing is an edit', () => {
    expect(envKeysChange(true, [], ['GITHUB_TOKEN'])).toEqual([]);
  });

  it('stays quiet when a loaded table matches the cloud', () => {
    expect(envKeysChange(true, buildEnvRows(FILE, ['LOG_LEVEL']), ['LOG_LEVEL'])).toBeNull();
  });

  it('sends the new list when the operator flags another key', () => {
    expect(envKeysChange(true, buildEnvRows(FILE, ['LOG_LEVEL', 'GITHUB_TOKEN']), ['LOG_LEVEL'])).toEqual([
      'LOG_LEVEL',
      'GITHUB_TOKEN',
    ]);
  });
});

describe('envEdits', () => {
  it('writes every named row and removes what the table dropped', () => {
    const rows: EnvRow[] = [
      { key: 'DATABASE_URL', value: 'postgres://prod/k', required: false },
      { key: 'NEW_KEY', value: 'v', required: false },
    ];
    expect(envEdits(rows, FILE)).toEqual({
      set: { DATABASE_URL: 'postgres://prod/k', NEW_KEY: 'v' },
      remove: ['LOG_LEVEL'],
    });
  });

  // A declared requirement with no value yet is NOT a variable: writing `KEY=`
  // would hand the agent an empty string where it expects a secret, and the
  // launch would fail further away from the cause.
  it('does not write a required placeholder that is not in the file', () => {
    const rows = buildEnvRows(FILE, ['GITHUB_TOKEN']);
    const edits = envEdits(rows, FILE);
    expect(edits.set).not.toHaveProperty('GITHUB_TOKEN');
    expect(edits.remove).toEqual([]);
  });

  // Clearing a line the operator can see is a deliberate edit, so it lands.
  it('writes an emptied value for a key that IS in the file', () => {
    const rows: EnvRow[] = [
      { key: 'DATABASE_URL', value: '', required: false },
      { key: 'LOG_LEVEL', value: 'debug', required: false },
    ];
    expect(envEdits(rows, FILE)).toEqual({
      set: { DATABASE_URL: '', LOG_LEVEL: 'debug' },
      remove: [],
    });
  });

  it('ignores a blank row and trims the key it writes under', () => {
    const rows: EnvRow[] = [
      { key: '', value: 'orphan', required: false },
      { key: '  LOG_LEVEL  ', value: 'info', required: false },
    ];
    expect(envEdits(rows, FILE)).toEqual({ set: { LOG_LEVEL: 'info' }, remove: ['DATABASE_URL'] });
  });

  it('removes every key when the table is emptied', () => {
    expect(envEdits([], FILE)).toEqual({ set: {}, remove: ['DATABASE_URL', 'LOG_LEVEL'] });
  });
});

// The GIT_TOKEN box in «Git Налаштування». It writes into the very table above,
// so its whole contract is which row it touches and what «cleared» means.
describe('setEnvValue', () => {
  it('appends a row for a key the table does not hold', () => {
    expect(setEnvValue([], 'GIT_TOKEN', 'ghp_x')).toEqual([
      { key: 'GIT_TOKEN', value: 'ghp_x', required: false },
    ]);
  });

  it('rewrites the existing row in place, keeping its required flag', () => {
    const rows = buildEnvRows([{ key: 'GIT_TOKEN', value: 'old' }], ['GIT_TOKEN']);
    expect(setEnvValue(rows, 'GIT_TOKEN', 'ghp_new')).toEqual([
      { key: 'GIT_TOKEN', value: 'ghp_new', required: true },
    ]);
  });

  // Clearing the field must take the LINE out, not leave `GIT_TOKEN=` behind: the
  // `.env` is copied into every worktree, and an empty secret there fails further
  // from the cause than a missing one.
  it('drops the row when the value is cleared, so envEdits removes the key', () => {
    const rows = buildEnvRows([...FILE, { key: 'GIT_TOKEN', value: 'ghp_x' }], []);
    const next = setEnvValue(rows, 'GIT_TOKEN', '');
    expect(next.map((r) => r.key)).toEqual(['DATABASE_URL', 'LOG_LEVEL']);
    expect(envEdits(next, [...FILE, { key: 'GIT_TOKEN', value: 'ghp_x' }]).remove).toEqual([
      'GIT_TOKEN',
    ]);
  });

  // A required key is a NAME the cloud shares (projects.env_keys). Dropping its row
  // would delete that declaration for the whole team, which is not what clearing a
  // local value asks for.
  it('empties a required row in place instead of dropping it', () => {
    const rows = buildEnvRows([{ key: 'GIT_TOKEN', value: 'ghp_x' }], ['GIT_TOKEN']);
    expect(setEnvValue(rows, 'GIT_TOKEN', '')).toEqual([
      { key: 'GIT_TOKEN', value: '', required: true },
    ]);
  });

  it('leaves the table alone when clearing a key it never held', () => {
    const rows = buildEnvRows(FILE, []);
    expect(setEnvValue(rows, 'GIT_TOKEN', '')).toEqual(rows);
  });
});
