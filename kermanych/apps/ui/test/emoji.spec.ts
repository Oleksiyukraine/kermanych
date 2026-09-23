import { describe, expect, it } from 'vitest';
import { ALL_EMOJIS, EMOJI_CATEGORIES } from '../src/lib/emoji';

// The picker's dataset is hand-curated, so the test guards the invariants a typo would
// break rather than pinning the exact glyphs: every category is populated, the tab glyph is
// itself one of its emojis, no category repeats a glyph, and the flat list is deduped. It
// also asserts the iOS-shaped categories the feature promised are present (flags, faces).
describe('EMOJI_CATEGORIES', () => {
  it('names every category the picker offers, in the iOS keyboard order', () => {
    expect(EMOJI_CATEGORIES.map((c) => c.key)).toEqual([
      'smileys',
      'animals',
      'food',
      'activity',
      'travel',
      'objects',
      'symbols',
      'flags',
    ]);
  });

  it('gives each category a non-empty, duplicate-free run whose tab glyph it contains', () => {
    for (const c of EMOJI_CATEGORIES) {
      expect(c.emojis.length, c.key).toBeGreaterThan(0);
      expect(new Set(c.emojis).size, `${c.key} has a duplicate`).toBe(c.emojis.length);
      expect(c.emojis, `${c.key} tab not in its list`).toContain(c.tab);
    }
  });

  it('carries the markers the feature promised — flags and a thumbs-up', () => {
    const flags = EMOJI_CATEGORIES.find((c) => c.key === 'flags');
    expect(flags?.emojis).toContain('🇺🇦');
    expect(ALL_EMOJIS).toContain('👍');
  });
});

describe('ALL_EMOJIS', () => {
  it('is the categories flattened and deduped', () => {
    expect(ALL_EMOJIS.length).toBe(new Set(ALL_EMOJIS).size);
    for (const c of EMOJI_CATEGORIES) {
      for (const e of c.emojis) expect(ALL_EMOJIS).toContain(e);
    }
  });
});
