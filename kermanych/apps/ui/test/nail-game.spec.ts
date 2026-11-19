import { describe, expect, it } from 'vitest';
import { NAIL_GAME_AI_STRIKE_MS } from '@kermanych/core';
import { NAIL_GAME_MAX_SCORE } from '@kermanych/cloud';
import {
  FRAME_CLAMP_MS,
  HIT_BONUS_MS,
  HIT_PAD,
  LINGER_MS,
  NAIL_H,
  NAIL_W,
  ROUND_MS,
  SPAWN_EVERY_MS,
  advance,
  createRound,
  hitNail,
  isOver,
  isStanding,
  nailAt,
  swingMiss,
  type Field,
  type Round,
} from '../src/lib/nail-game';
import { boardFor, createSeat, stepSeat, takePlan } from '../src/lib/nail-game-ai';

// «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decision 1;
// docs/specs/2026-11-19-nail-game-ai-opponents.md). What a player would notice: a nail that
// scores on the wrong hit, a nail vanishing under the hammer, a round that runs on while the
// window is hidden, a swing next to a nail that does not count, a driven nail that disappears,
// points going to the wrong player — and a perfect round that the database then refuses.
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
    const straight = createRound(field, 1, firstRoll(0.9, seeded(1)));
    const s = straight.nails[0]!;
    expect([s.kind, hitNail(straight, s.id), hitNail(straight, s.id)]).toEqual(['straight', 0, 1]);
    expect(isStanding(s)).toBe(false);

    const bent = createRound(field, 1, firstRoll(0.1, seeded(1)));
    const b = bent.nails[0]!;
    expect([b.kind, hitNail(bent, b.id), hitNail(bent, b.id), hitNail(bent, b.id)]).toEqual(['bent', 0, 0, 2]);
    const me = bent.players[0]!;
    expect([me.score, me.driven, me.hits, me.swings]).toEqual([2, 1, 3, 3]);

    // A driven nail takes no more points, and the swing counts as a miss.
    expect(hitNail(bent, b.id)).toBe(0);
    expect([me.score, me.hits, me.swings]).toEqual([2, 3, 4]);
  });

  it('an unhit nail escapes and leaves; a hit keeps it up longer', () => {
    const r = createRound(field, 1, seeded(2));
    const left = r.nails[0]!;
    play(r, left.expiresAt + 16);
    expect(left.escapedAt).not.toBeNull();
    play(r, LINGER_MS + 16);
    expect(r.nails.some((n) => n.id === left.id)).toBe(false);

    const kept = createRound(field, 1, firstRoll(0.1, seeded(3)));
    const n = kept.nails[0]!;
    play(kept, n.expiresAt - 100);
    hitNail(kept, n.id);
    play(kept, HIT_BONUS_MS - 200);
    expect(isStanding(n)).toBe(true);
  });

  it('a driven nail stays on the board, credited to who drove it, until the round ends', () => {
    const r = createRound(field, 1, firstRoll(0.9, seeded(8)));
    const n = r.nails[0]!;
    hitNail(r, n.id);
    hitNail(r, n.id);
    play(r, ROUND_MS + 1000, 50);
    expect(r.nails.find((x) => x.id === n.id)).toMatchObject({ by: 0, doneAt: expect.any(Number) });
  });

  it('a swing in the margin around a nail lands on it, the nearest nail wins, a driven one is not hit', () => {
    const r = createRound(field, 1, firstRoll(0.9, seeded(9)));
    const n = r.nails[0]!;
    expect(nailAt(r, n.x - HIT_PAD + 2, n.y + NAIL_H / 2)?.id).toBe(n.id);
    expect(nailAt(r, n.x + NAIL_W + HIT_PAD + 2, n.y + NAIL_H / 2)).toBeNull();

    // A second nail right beside it: a swing just inside the second's box picks the second.
    const twin = { ...n, id: 999, x: n.x + NAIL_W + 4 };
    r.nails.push(twin);
    expect(nailAt(r, twin.x + 4, twin.y + NAIL_H / 2)?.id).toBe(twin.id);

    hitNail(r, twin.id);
    hitNail(r, twin.id);
    expect(nailAt(r, twin.x + 4, twin.y + NAIL_H / 2)?.id).toBe(n.id);
  });

  it('the points go to the player whose strike drives the nail in', () => {
    const r = createRound(field, 2, firstRoll(0.1, seeded(10)));
    const b = r.nails[0]!;
    hitNail(r, b.id, 0);
    hitNail(r, b.id, 0);
    expect(hitNail(r, b.id, 1)).toBe(2);
    expect(r.players.map((p) => [p.score, p.hits, p.driven])).toEqual([
      [0, 2, 0],
      [2, 1, 1],
    ]);
    expect(b.by).toBe(1);
  });

  it('a long frame counts as at most FRAME_CLAMP_MS, so a hidden window pauses the round', () => {
    const r = createRound(field, 1, seeded(4));
    advance(r, 30_000);
    expect(r.now).toBe(FRAME_CLAMP_MS);
  });

  it('ends at 60 s and takes no swings after it', () => {
    const r = createRound(field, 1, seeded(5));
    play(r, ROUND_MS + 1000, 50);
    expect([isOver(r), r.now]).toEqual([true, ROUND_MS]);
    const swings = r.players[0]!.swings;
    swingMiss(r);
    const standing = r.nails.find(isStanding);
    if (standing) hitNail(r, standing.id);
    expect(r.players[0]!.swings).toBe(swings);
  });

  it('starts with at most 3 nails standing', () => {
    const r = createRound(field, 1, seeded(6));
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
    const r = createRound(field, 1, seeded(7));
    while (!isOver(r)) {
      for (const n of r.nails.filter(isStanding)) while (isStanding(n)) hitNail(r, n.id);
      advance(r, 16);
    }
    const me = r.players[0]!;
    expect(r.nextId - 1).toBeLessThanOrEqual(ticks);
    expect(me.score).toBeLessThanOrEqual(NAIL_GAME_MAX_SCORE);
    expect(me.hits).toBe(me.swings);
  });
});

describe('nail game AI seat', () => {
  it('plays its plan one strike per NAIL_GAME_AI_STRIKE_MS and scores the nail it drives', () => {
    const r = createRound(field, 2, firstRoll(0.9, seeded(11)));
    const n = r.nails[0]!;
    const seat = createSeat(1, 'claude-haiku-4-5', { x: 0, y: 0 });
    takePlan(seat, [n.id, n.id]);
    let struck = 0;
    for (let t = 16; t <= NAIL_GAME_AI_STRIKE_MS * 2 + 64; t += 16) {
      advance(r, 16);
      if (stepSeat(r, seat, 16) !== null) struck += 1;
      // Not before its cycle: one strike at most per NAIL_GAME_AI_STRIKE_MS.
      expect(struck).toBeLessThanOrEqual(Math.floor(t / NAIL_GAME_AI_STRIKE_MS));
    }
    expect([struck, n.by, r.players[1]!.score, r.players[0]!.score]).toEqual([2, 1, 1, 0]);
  });

  it('drops strikes on a nail that is gone without swinging, and reports the board it is shown', () => {
    const r = createRound(field, 2, firstRoll(0.9, seeded(12)));
    const n = r.nails[0]!;
    const seat = createSeat(1, 'claude-haiku-4-5', { x: 0, y: 0 });
    hitNail(r, n.id, 0);
    expect(boardFor(r, seat)).toMatchObject({ you: 0, rival: 0, nails: [{ id: n.id, kind: 'straight', strikes: 1 }] });

    hitNail(r, n.id, 0);
    takePlan(seat, [n.id, n.id]);
    expect(stepSeat(r, seat, NAIL_GAME_AI_STRIKE_MS)).toBeNull();
    expect([seat.queue, r.players[1]!.swings]).toEqual([[], 0]);
    expect(boardFor(r, seat)).toMatchObject({ you: 0, rival: 1, nails: [] });
  });
});
