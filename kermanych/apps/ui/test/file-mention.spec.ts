import { describe, expect, it } from 'vitest';
import { insertFileMention, opensMention } from '../src/lib/file-mention';

// The token is the whole contract with the agent: `@path` the harness reads as a file, kept
// apart from the words around it, the typed `@` replaced rather than doubled.
describe('opensMention', () => {
  it('opens at the start and after whitespace, never mid-word', () => {
    expect(opensMention('', 0)).toBe(true);
    expect(opensMention('see ', 4)).toBe(true);
    expect(opensMention('line\n', 5)).toBe(true);
    expect(opensMention('mail me at me', 13)).toBe(false);
  });
});

describe('insertFileMention', () => {
  it('replaces the typed @ with the token and puts the caret after it', () => {
    expect(insertFileMention('fix @', 4, 'src/a.ts', true)).toEqual({ value: 'fix @src/a.ts ', caret: 14 });
  });

  it('inserts at the caret, spaced from the words on both sides, without doubling a space', () => {
    expect(insertFileMention('fixthis', 3, 'a.ts', false)).toEqual({ value: 'fix @a.ts this', caret: 10 });
    expect(insertFileMention('fix this', 3, 'a.ts', false)).toEqual({ value: 'fix @a.ts this', caret: 9 });
  });

  it('does not eat a character that is not the typed @', () => {
    expect(insertFileMention('ab', 1, 'a.ts', true)).toEqual({ value: 'a @a.ts b', caret: 8 });
  });

  it('quotes a path with whitespace so the token does not end at its first space', () => {
    expect(insertFileMention('', 0, 'docs/My Notes.md', false).value).toBe('@"docs/My Notes.md" ');
  });
});
