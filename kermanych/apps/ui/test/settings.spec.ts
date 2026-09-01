import { describe, expect, it } from 'vitest';
import type { EnvEntry } from '@kermanych/core';
import {
  buildEnvRows,
  changedFields,
  envEdits,
  envRequiredKeys,
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
    expect(settingsSection('workspace-members').label).toBe('Учасники');
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

  // The skill library used to be a Менеджмент screen of its own. It is a project
  // setting, so the rail — not the Менеджмент sub-nav — is where it is reached, and
  // the scope is what keeps it hidden until a project is selected.
  it('carries the skill library at the project scope', () => {
    const skills = settingsSection('project-skills');
    expect(skills.key).toBe('project-skills');
    expect(skills.scope).toBe('project');
    expect(skills.label).toBe('Бібліотека скілів');
  });

  // The agent catalogue is an APP setting, not a project one: `AGENTS` is a compile-time
  // constant of the harness itself, identical for every project and every workspace.
  it('carries the agent catalogue at the app scope', () => {
    const agents = settingsSection('app-agents');
    expect(agents.key).toBe('app-agents');
    expect(agents.scope).toBe('app');
    expect(agents.label).toBe('ШІ команда');
  });

  // The board is the mirror image of the catalogue above: the team is app-wide, but WHICH
  // skills each role is handed is a per-project decision, stored per project — so it is the
  // project scope that keeps the pane hidden until there is a project to write for.
  it('carries the assignment board at the project scope', () => {
    const board = settingsSection('project-agents');
    expect(board.key).toBe('project-agents');
    expect(board.scope).toBe('project');
    expect(board.label).toBe('Призначення');
  });

  // Triggers are the third project-scoped pane of «ШІ команда» and the last row of the rail's
  // project block before the danger zone: a trigger names a skill from THIS project's library
  // and is stored per project, so it cannot live at the app scope beside the catalogue.
  it('carries the trigger list at the project scope', () => {
    const triggers = settingsSection('project-triggers');
    expect(triggers.key).toBe('project-triggers');
    expect(triggers.scope).toBe('project');
    expect(triggers.label).toBe('Тригери');
  });

  // Хелпери are baked into the app exactly like `AGENTS`, so they sit beside the agent
  // catalogue at the app scope: nothing here is per-project, and the pane is read-only.
  it('carries the helper catalogue at the app scope', () => {
    const helpers = settingsSection('app-helpers');
    expect(helpers.key).toBe('app-helpers');
    expect(helpers.scope).toBe('app');
    expect(helpers.label).toBe('Хелпери');
  });

  // The default launch model is per-project cloud config, written through the same projects
  // patch as branches and conventions, so the pane lives at the project scope.
  it('carries the launch defaults at the project scope', () => {
    const defaults = settingsSection('project-defaults');
    expect(defaults.key).toBe('project-defaults');
    expect(defaults.scope).toBe('project');
    expect(defaults.label).toBe('Запуск задач');
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
