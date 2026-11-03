import { describe, expect, it } from 'vitest';
import { createCircleRecognizer, type GesturePoint } from '../src/lib/circle-gesture';

// Samples at 60 Hz. `dir` 1 draws counter-clockwise ON SCREEN (y grows downward).
function circle(opts: { r?: number; turns?: number; ms?: number; dir?: 1 | -1; t0?: number } = {}): GesturePoint[] {
  const { r = 100, turns = 1.1, ms = 800, dir = 1, t0 = 0 } = opts;
  const n = Math.round((ms / 1000) * 60);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = dir * (i / n) * turns * Math.PI * 2;
    return { x: 500 + r * Math.cos(a), y: 400 - r * Math.sin(a), t: t0 + (i / n) * ms };
  });
}

function feed(points: GesturePoint[], buttons = 0): boolean[] {
  const rec = createCircleRecognizer();
  return points.map((p) => rec.move(p, buttons));
}

describe('circle gesture', () => {
  it('fires once a counter-clockwise circle closes, and not before', () => {
    const hits = feed(circle());
    expect(hits.filter(Boolean)).toHaveLength(1);
    // Not on the first half of the stroke.
    expect(hits.slice(0, Math.floor(hits.length / 2)).some(Boolean)).toBe(false);
  });

  it('ignores a clockwise circle', () => {
    expect(feed(circle({ dir: -1, turns: 1.5 })).some(Boolean)).toBe(false);
  });

  it('ignores an unfinished circle', () => {
    expect(feed(circle({ turns: 0.85 })).some(Boolean)).toBe(false);
  });

  it('ignores a circle drawn with a button held (a drag)', () => {
    expect(feed(circle(), 1).some(Boolean)).toBe(false);
  });

  it('ignores circles that are too small or too large', () => {
    expect(feed(circle({ r: 20 })).some(Boolean)).toBe(false);
    expect(feed(circle({ r: 450 })).some(Boolean)).toBe(false);
  });

  it('ignores a circle slower than the window', () => {
    expect(feed(circle({ ms: 2000 })).some(Boolean)).toBe(false);
  });

  it('does not join two strokes separated by a pause', () => {
    const first = circle({ turns: 0.6 });
    const second = circle({ turns: 0.6, t0: 1000 }).map((p) => {
      // The second half of the circle, after the pointer rested.
      const a = Math.atan2(400 - p.y, p.x - 500) + 0.6 * Math.PI * 2;
      return { x: 500 + 100 * Math.cos(a), y: 400 - 100 * Math.sin(a), t: p.t };
    });
    expect(feed([...first, ...second]).some(Boolean)).toBe(false);
  });

  it('ignores a left-right shake and a straight line', () => {
    const shake = Array.from({ length: 60 }, (_, i) => ({ x: 500 + (i % 10 < 5 ? (i % 5) * 40 : (5 - (i % 5)) * 40), y: 400 + (i % 3), t: i * 16 }));
    expect(feed(shake).some(Boolean)).toBe(false);
    const line = Array.from({ length: 60 }, (_, i) => ({ x: 200 + i * 8, y: 400, t: i * 16 }));
    expect(feed(line).some(Boolean)).toBe(false);
  });

  it('accepts a hand-drawn ellipse', () => {
    const pts = circle({ turns: 1.15 }).map((p) => ({ ...p, x: 500 + (p.x - 500) * 1.4, y: 400 + (p.y - 400) * 0.8 }));
    expect(feed(pts).some(Boolean)).toBe(true);
  });
});
