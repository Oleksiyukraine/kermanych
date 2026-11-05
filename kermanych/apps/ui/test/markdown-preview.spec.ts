import { describe, expect, it } from 'vitest';
import { markdownPreview } from '../src/lib/markdown-preview';

// A backlog card shows its description as one line. A finding's report is the usual worst
// case: section headings, checkboxes, code spans and evidence paths.
describe('markdownPreview', () => {
  it('reads a finding report as its prose, without headings or list markup', () => {
    const md = [
      '## Context',
      'The comment above the `deep-analysis` default is **stale**.',
      '',
      '## Acceptance criteria',
      '- [ ] The comment states the rule.',
      '- [x] No limit is claimed.',
      '1. First step',
      '> quoted note',
    ].join('\n');
    expect(markdownPreview(md)).toBe(
      'The comment above the deep-analysis default is stale. The comment states the rule. No limit is claimed. First step quoted note',
    );
  });

  it('keeps link text and drops code fences, keeping the code lines', () => {
    expect(markdownPreview('See [the spec](https://x.test/a).\n```ts\nconst a = 1;\n```')).toBe('See the spec. const a = 1;');
  });

  it('leaves identifiers that only look like emphasis alone', () => {
    expect(markdownPreview('rename snake__case__name and a*b*c, glob **/*.ts')).toBe(
      'rename snake__case__name and a*b*c, glob **/*.ts',
    );
    expect(markdownPreview('__bold__ word')).toBe('bold word');
  });

  it('is empty for no description, or one with nothing but markup', () => {
    expect(markdownPreview(undefined)).toBe('');
    expect(markdownPreview('   \n\n')).toBe('');
    expect(markdownPreview('## Context\n---\n')).toBe('');
  });
});
