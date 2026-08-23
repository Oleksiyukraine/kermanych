import { describe, expect, it } from 'vitest';
import { initialsOf } from '../src/lib/initials';

// Both squares in the left rail — the project tile and the account tile at its foot — stand
// in for a name with these two letters, so a GitHub handle and a repo path must reduce the
// same way and an empty name must never render as an empty tile.
describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Oleksii Motornyi', '?')).toBe('OM');
    expect(initialsOf('Kermanych UI Shell', '?')).toBe('KU');
  });

  it('treats slashes, dashes and underscores as word separators', () => {
    expect(initialsOf('kermanych/ui', '?')).toBe('KU');
    expect(initialsOf('oleksii-motornyi', '?')).toBe('OM');
    expect(initialsOf('design_system', '?')).toBe('DS');
  });

  it('falls back to the first two characters of a single word', () => {
    expect(initialsOf('kermanych', '?')).toBe('KE');
    expect(initialsOf('k', '?')).toBe('K');
  });

  it("returns the caller's glyph for a name with no letters at all", () => {
    expect(initialsOf('', '?')).toBe('?');
    expect(initialsOf('   ', '·')).toBe('·');
  });
});
