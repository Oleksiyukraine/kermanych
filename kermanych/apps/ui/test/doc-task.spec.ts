import { describe, expect, it } from 'vitest';
import { canTaskFromDoc, docTaskDeepAnalysis, docTaskFraming, docTaskScreensDir, docTaskTargets, docTaskTitle, isDesignReadme } from '../src/lib/doc-task';

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

// What the other side is told binds it, and how it starts
// (docs/specs/2026-11-07-cross-agent-request-handoff-framing.md, decisions 3–5).
describe('docTaskFraming and docTaskDeepAnalysis', () => {
  it('frames an API request and offers deep analysis ticked', () => {
    expect(docTaskFraming('docs/api-requests/2026-10-01-orders.md')).toBe('apiRequest');
    expect(docTaskDeepAnalysis('docs/api-requests/2026-10-01-orders.md')).toBe(true);
  });
  it('frames a handoff and offers deep analysis clear', () => {
    expect(docTaskFraming('docs/handoffs/2026-10-01-orders.md')).toBe('handoff');
    expect(docTaskDeepAnalysis('docs/handoffs/2026-10-01-orders.md')).toBe(false);
  });
  it('leaves a design README as it is: no framing, no checkbox', () => {
    expect(docTaskFraming(README)).toBeUndefined();
    expect(docTaskDeepAnalysis(README)).toBeUndefined();
  });
});
