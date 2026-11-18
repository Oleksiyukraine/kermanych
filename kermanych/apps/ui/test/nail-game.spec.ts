import { describe, expect, it } from 'vitest';
import { NAIL_GAME_MAX_SCORE } from '@kermanych/cloud';
import {
  FRAME_CLAMP_MS,
  HIT_BONUS_MS,
  LINGER_MS,
  ROUND_MS,
  SPAWN_EVERY_MS,
  advance,
  createRound,
  hitNail,
  isOver,
  isStanding,
  swingMiss,
  type Field,
  type Round,
} from '../src/lib/nail-game';

// «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decision 1). What a player would
// notice: a nail that scores on the wrong hit, a nail vanishing under the hammer, a round that
// runs on while the window is hidden — and a perfect round that the database then refuses.
const field: Field = { width: 1600, height: 1000, top: 80, pad: 24 };

// A deterministic stream (mulberry32), so a round replays the same way every run.
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The first nail draws x, y, then the bent-or-straight roll: answer `roll` to that third draw.
function firstRoll(roll: number, rest: () => number): () => number {
  let draw = 0;
  return () => (draw++ === 2 ? roll : rest());
}

function play(r: Round, ms: number, step = 16): void {
  for (let t = 0; t < ms; t += step) advance(r, step);
}

describe('nail game round', () => {
  it('a straight nail scores 1 on its second hit, a bent one 2 on its third', () => {
    const straight = createRound(field, firstRoll(0.9, seeded(1)));
    const s = straight.nails[0]!;
    expect([s.kind, hitNail(straight, s.id), hitNail(straight, s.id)]).toEqual(['straight', 0, 1]);
    expect(isStanding(s)).toBe(false);

    const bent = createRound(field, firstRoll(0.1, seeded(1)));
    const b = bent.nails[0]!;
    expect([b.kind, hitNail(bent, b.id), hitNail(bent, b.id), hitNail(bent, b.id)]).toEqual(['bent', 0, 0, 2]);
    expect([bent.score, bent.driven, bent.hits, bent.swings]).toEqual([2, 1, 3, 3]);

    // A driven nail takes no more points, and the swing counts as a miss.
    expect(hitNail(bent, b.id)).toBe(0);
    expect([bent.score, bent.hits, bent.swings]).toEqual([2, 3, 4]);
  });

  it('an unhit nail escapes and leaves; a hit keeps it up longer', () => {
    const r = createRound(field, seeded(2));
    const left = r.nails[0]!;
    play(r, left.expiresAt + 16);
    expect(left.escapedAt).not.toBeNull();
    play(r, LINGER_MS + 16);
    expect(r.nails.some((n) => n.id === left.id)).toBe(false);

    const kept = createRound(field, firstRoll(0.1, seeded(3)));
    const n = kept.nails[0]!;
    play(kept, n.expiresAt - 100);
    hitNail(kept, n.id);
    play(kept, HIT_BONUS_MS - 200);
    expect(isStanding(n)).toBe(true);
  });

  it('a long frame counts as at most FRAME_CLAMP_MS, so a hidden window pauses the round', () => {
    const r = createRound(field, seeded(4));
    advance(r, 30_000);
    expect(r.now).toBe(FRAME_CLAMP_MS);
  });

  it('ends at 60 s and takes no swings after it', () => {
    const r = createRound(field, seeded(5));
    play(r, ROUND_MS + 1000, 50);
    expect([isOver(r), r.now]).toEqual([true, ROUND_MS]);
    const swings = r.swings;
    swingMiss(r);
    const standing = r.nails.find(isStanding);
    if (standing) hitNail(r, standing.id);
    expect(r.swings).toBe(swings);
  });

  it('starts with at most 3 nails standing', () => {
    const r = createRound(field, seeded(6));
    play(r, 5000);
    expect(r.nails.filter(isStanding).length).toBeLessThanOrEqual(3);
  });

  it('perfect play stays within the score the database accepts', () => {
    // The bound: one nail per spawn tick at most, each worth at most 2 (bent).
    let ticks = 0;
    for (let t = 0; t <= ROUND_MS; t += SPAWN_EVERY_MS[0] + (SPAWN_EVERY_MS[1] - SPAWN_EVERY_MS[0]) * Math.min(1, t / ROUND_MS)) {
      ticks += 1;
    }
    expect(ticks * 2).toBeLessThanOrEqual(NAIL_GAME_MAX_SCORE);

    // And a round where every nail is driven the frame it appears.
    const r = createRound(field, seeded(7));
    while (!isOver(r)) {
      for (const n of r.nails.filter(isStanding)) while (isStanding(n)) hitNail(r, n.id);
      advance(r, 16);
    }
    expect(r.nextId - 1).toBeLessThanOrEqual(ticks);
    expect(r.score).toBeLessThanOrEqual(NAIL_GAME_MAX_SCORE);
    expect(r.hits).toBe(r.swings);
  });
});
