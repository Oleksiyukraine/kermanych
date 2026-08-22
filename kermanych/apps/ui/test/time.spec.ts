import { describe, expect, it } from 'vitest';
import { dur } from '../src/lib/time';

// The reasoning chip, the collapsed block summary and the status row all print the same
// quantity through this one function, so a minute-scale reasoning cannot read `127 с` in
// the chip and `2 хв` in the summary one press away.
describe('dur', () => {
  it('floors a sub-second span instead of claiming no time passed', () => {
    expect(dur(0)).toBe('<1 с');
    expect(dur(999)).toBe('<1 с');
  });

  it('prints whole seconds below a minute', () => {
    expect(dur(1000)).toBe('1 с');
    expect(dur(8400)).toBe('8 с');
    expect(dur(59_000)).toBe('59 с');
  });

  it('switches to whole minutes at a minute', () => {
    expect(dur(60_000)).toBe('1 хв');
    expect(dur(127_000)).toBe('2 хв');
    expect(dur(600_000)).toBe('10 хв');
  });
});
