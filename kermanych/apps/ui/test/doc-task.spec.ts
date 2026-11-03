import { describe, expect, it } from 'vitest';
import {
  canTaskFromDoc,
  docTaskPlatform,
  docTaskScreensDir,
  docTaskTargets,
  docTaskTitle,
  isDesignReadme,
} from '../src/lib/doc-task';

const README = 'docs/design/2026-10-29-orders-list/README.md';

describe('isDesignReadme', () => {
  it('is the README directly in a design folder', () => expect(isDesignReadme(README)).toBe(true));
  it('is not another file of the folder', () =>
    expect(isDesignReadme('docs/design/2026-10-29-orders-list/notes.md')).toBe(false));
  it('is not a README nested deeper in the folder', () =>
    expect(isDesignReadme('docs/design/2026-10-29-orders-list/screens/README.md')).toBe(false));
  it('is not a README directly under docs/design', () => expect(isDesignReadme('docs/design/README.md')).toBe(false));
});

describe('canTaskFromDoc', () => {
  it('offers an API request, a handoff and a design README', () => {
    expect(canTaskFromDoc('docs/api-requests/2026-10-01-orders.md')).toBe(true);
    expect(canTaskFromDoc('docs/handoffs/2026-10-01-orders.md')).toBe(true);
    expect(canTaskFromDoc(README)).toBe(true);
  });
  it('does not offer a spec, nor a screenshot of a design', () => {
    expect(canTaskFromDoc('docs/specs/2026-10-01-orders.md')).toBe(false);
    expect(canTaskFromDoc('docs/design/2026-10-29-orders-list/screens/list-empty@390.png')).toBe(false);
  });
});

describe('docTaskPlatform', () => {
  it('is backend for an API request and web for a design', () => {
    expect(docTaskPlatform('docs/api-requests/2026-10-01-orders.md')).toBe('backend');
    expect(docTaskPlatform(README)).toBe('web');
  });
  it('is left to the operator for a handoff', () => expect(docTaskPlatform('docs/handoffs/x.md')).toBeUndefined());
});

describe('docTaskTitle', () => {
  it('takes the first heading', () => expect(docTaskTitle(README, 'intro\n# Orders list\n## Screens')).toBe('Orders list'));
  it('falls back to the file name without the date', () =>
    expect(docTaskTitle('docs/handoffs/2026-10-01-orders-api.md', 'no heading')).toBe('orders-api'));
  it('falls back to the folder name for a design README', () =>
    expect(docTaskTitle(README, 'no heading')).toBe('orders-list'));
});

describe('docTaskTargets', () => {
  const home = { id: 'fe', workspaceId: 'w1' };
  const projects = [
    { id: 'api', workspaceId: 'w1' },
    { id: 'fe', workspaceId: 'w1' },
    { id: 'other', workspaceId: 'w2' },
    { id: 'mobile', workspaceId: 'w1' },
  ];

  it('offers only the other projects of the workspace for a handoff', () =>
    expect(docTaskTargets(projects, home, 'docs/handoffs/x.md').map((p) => p.id)).toEqual(['api', 'mobile']));
  it('puts the own project first for a design, the rest of the workspace after it', () =>
    expect(docTaskTargets(projects, home, README).map((p) => p.id)).toEqual(['fe', 'api', 'mobile']));
});

describe('docTaskScreensDir', () => {
  it('is the folder screens/ for a design README', () =>
    expect(docTaskScreensDir(README)).toBe('docs/design/2026-10-29-orders-list/screens'));
  it('is undefined for any other document', () => expect(docTaskScreensDir('docs/handoffs/x.md')).toBeUndefined());
});
