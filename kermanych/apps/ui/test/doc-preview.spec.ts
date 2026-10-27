import { describe, expect, it } from 'vitest';
import { docPreviewKind, initialViewMode, rememberedViewMode } from '../src/lib/doc-preview';

describe('docPreviewKind', () => {
  it('names the rendered form by extension, case-insensitively', () => {
    expect(docPreviewKind('docs/specs/design.md')).toBe('markdown');
    expect(docPreviewKind('README.MARKDOWN')).toBe('markdown');
    expect(docPreviewKind('site/index.html')).toBe('html');
    expect(docPreviewKind('legacy/page.HTM')).toBe('html');
    expect(docPreviewKind('contracts/offer.pdf')).toBe('pdf');
  });

  it('leaves every other file to the source view', () => {
    expect(docPreviewKind('src/main.ts')).toBeNull();
    expect(docPreviewKind('notes.md.bak')).toBeNull();
    expect(docPreviewKind('pages/intro.mdx')).toBeNull();
    expect(docPreviewKind('Makefile')).toBeNull();
  });
});

describe('initialViewMode', () => {
  it('opens in the remembered mode, but never a PDF on its source', () => {
    rememberedViewMode.value = 'source';
    expect(initialViewMode('markdown')).toBe('source');
    expect(initialViewMode('pdf')).toBe('preview');
    rememberedViewMode.value = 'split';
    expect(initialViewMode('html')).toBe('split');
    expect(initialViewMode('pdf')).toBe('split');
  });
});
