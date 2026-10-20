import { describe, it, expect } from 'vitest';
import { followAfterScroll } from '../src/lib/log-follow';

describe('followAfterScroll', () => {
  it('a small upward scroll by the operator stops the follow, even inside the bottom slack', () => {
    // A trackpad moves a few px per event; while the agent streams, the log must not pull back.
    expect(followAfterScroll({ follow: true, prevTop: 1000, top: 994, gap: 6, byUser: true })).toBe(false);
  });

  it('an upward scroll the layout causes keeps the follow', () => {
    // The log grew taller (status row gone, composer shrank): the browser clamps scrollTop down,
    // still at the bottom.
    expect(followAfterScroll({ follow: true, prevTop: 1000, top: 950, gap: 0, byUser: false })).toBe(true);
    // Scroll anchoring moved the view while no one touched it.
    expect(followAfterScroll({ follow: true, prevTop: 1000, top: 900, gap: 300, byUser: false })).toBe(true);
  });

  it('a clamp at the bottom during the operator\'s scroll does not count as moving up', () => {
    expect(followAfterScroll({ follow: true, prevTop: 1000, top: 960, gap: 0, byUser: true })).toBe(true);
  });

  it('coming back down to the bottom resumes the follow', () => {
    expect(followAfterScroll({ follow: false, prevTop: 900, top: 980, gap: 20, byUser: true })).toBe(true);
    expect(followAfterScroll({ follow: false, prevTop: 900, top: 1000, gap: 0, byUser: false })).toBe(true);
  });

  it('the operator scrolling down but short of the bottom does not resume it', () => {
    expect(followAfterScroll({ follow: false, prevTop: 400, top: 500, gap: 500, byUser: true })).toBe(false);
  });

  it('a layout scroll away from the bottom leaves a stopped follow stopped', () => {
    expect(followAfterScroll({ follow: false, prevTop: 400, top: 450, gap: 500, byUser: false })).toBe(false);
  });
});
