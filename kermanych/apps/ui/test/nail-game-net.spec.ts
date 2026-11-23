import { describe, expect, it } from 'vitest';
import { advance, createRound, isOver, isStanding, type Nail, type Round } from '../src/lib/nail-game';
import {
  HOST_SILENT_MS,
  ROOM_FIELD,
  SNAPSHOT_MS,
  applyHost,
  createHost,
  createMirror,
  hostOutgoing,
  hostSnapshot,
  hostSwing,
  readGuestMsg,
  tickMirror,
  type HostMsg,
} from '../src/lib/nail-game-net';

// «Гвіздки» with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md, decision 2). What a
// player would notice: a guest's board that drifts from the host's, a nail that stays half-driven
// on one screen after a lost packet, points for a nail someone else finished first, a clock that
// runs on while the host is away, and a colleague's score vanishing when they leave.

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAME = 16;

// Three players hammering away for a whole round; every message the host sends goes through
// `deliver`, which may drop it.
function playRound(deliver: (msg: HostMsg, wall: number, r: Round) => void): Round {
  const r = createRound({ ...ROOM_FIELD }, 3, seeded(7));
  const h = createHost();
  for (let frame = 1; !isOver(r); frame += 1) {
    const wall = frame * FRAME;
    advance(r, FRAME);
    const standing = r.nails.filter(isStanding);
    const target = (who: number) => (who === 2 ? standing.at(-1) : standing[0]);
    for (const [who, every] of [[0, 9], [1, 7], [2, 11]] as const) {
      if (frame % every) continue;
      const n = target(who);
      hostSwing(r, h, { who, nailId: n?.id ?? null, x: n?.x ?? 5, y: n?.y ?? 5 });
    }
    for (const msg of hostOutgoing(r, h, wall)) deliver(msg, wall, r);
    if (isOver(r)) deliver(hostSnapshot(r, h, wall, 'end'), wall, r);
  }
  return r;
}

// The host's nails as a guest must see them; the mirror may still hold escaped ones on their way out.
const byId = (nails: Nail[]) => new Map(nails.map((n) => [n.id, n]));

describe('a room: the host judges, guests mirror', () => {
  it('a guest sees the host\'s board after every batch, and the same final tally', () => {
    const m = createMirror(3, 0);
    let checked = 0;
    const host = playRound((msg, wall, r) => {
      applyHost(m, msg, wall);
      if (msg.t !== 'batch') return;
      const mine = byId(m.round.nails);
      for (const n of r.nails) expect(mine.get(n.id)).toEqual(n);
      expect(m.round.players).toEqual(r.players);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(100);
    expect(m.ended).toBe(true);
    expect(m.round.players).toEqual(host.players);
    expect(m.round.nails).toEqual(host.nails);
    // Everyone scored something, so the board really was contested.
    expect(host.players.every((p) => p.score > 0)).toBe(true);
  });

  it('a lost batch is mended by the next snapshot', () => {
    const m = createMirror(3, 0);
    let lostAt: number | null = null;
    let diverged = false;
    let mended = false;
    playRound((msg, wall, r) => {
      // Lose the first batch that drives a nail in, then watch the guest's board.
      if (lostAt === null && msg.t === 'batch' && msg.swings.some((s) => s.drove)) {
        lostAt = wall;
        return;
      }
      applyHost(m, msg, wall);
      if (lostAt === null || mended) return;
      const mine = byId(m.round.nails);
      const same = r.nails.every((n) => JSON.stringify(mine.get(n.id)) === JSON.stringify(n));
      if (!same) diverged = true;
      if (msg.t === 'snap') {
        expect(same).toBe(true);
        expect(wall - lostAt).toBeLessThanOrEqual(SNAPSHOT_MS);
        mended = true;
      }
    });
    expect(diverged).toBe(true);
    expect(mended).toBe(true);
  });

  it('a blow on a nail someone else drove in first is a miss; the points go to the finishing blow', () => {
    const r = createRound({ ...ROOM_FIELD }, 3, () => 0.9);
    const h = createHost();
    const n = r.nails[0]!;
    expect(n.needed).toBe(2);
    expect(hostSwing(r, h, { who: 1, nailId: n.id, x: n.x, y: n.y })).toEqual({ hit: true, points: 0 });
    expect(hostSwing(r, h, { who: 2, nailId: n.id, x: n.x, y: n.y })).toEqual({ hit: true, points: 1 });
    expect(hostSwing(r, h, { who: 1, nailId: n.id, x: n.x, y: n.y })).toEqual({ hit: false, points: 0 });
    expect(r.players.map((p) => [p.score, p.hits, p.swings])).toEqual([
      [0, 0, 0],
      [0, 1, 2],
      [1, 1, 1],
    ]);
    expect(n.by).toBe(2);
    expect(h.swings.map((s) => [s.who, s.hit, s.drove])).toEqual([
      [1, true, false],
      [2, true, true],
      [1, false, false],
    ]);
  });

  it('a paused or silent host stops the guest\'s clock; an older message is dropped', () => {
    const r = createRound({ ...ROOM_FIELD }, 2, seeded(3));
    const h = createHost();
    const m = createMirror(2, 0);
    advance(r, 50);
    applyHost(m, hostSnapshot(r, h, 0), 0);
    tickMirror(m, FRAME, FRAME);
    expect(m.round.now).toBe(50 + FRAME);

    h.paused = true;
    applyHost(m, hostSnapshot(r, h, 100), 100);
    tickMirror(m, FRAME, 116);
    expect(m.round.now).toBe(50);

    h.paused = false;
    const stale = hostSnapshot(r, h, 200);
    applyHost(m, hostSnapshot(r, h, 216), 216);
    tickMirror(m, FRAME, 232);
    expect(m.round.now).toBe(50 + FRAME);
    advance(r, 1000);
    expect(applyHost(m, stale, 240)).toEqual([]);
    expect(m.round.now).toBe(50 + FRAME);

    // Nothing from the host for HOST_SILENT_MS: the guest waits instead of running on.
    tickMirror(m, FRAME, 216 + HOST_SILENT_MS);
    expect(m.round.now).toBe(50 + FRAME);
  });

  it('a guest who left keeps their score on everyone\'s board', () => {
    const r = createRound({ ...ROOM_FIELD }, 3, () => 0.9);
    const h = createHost();
    const n = r.nails[0]!;
    hostSwing(r, h, { who: 2, nailId: n.id, x: n.x, y: n.y });
    hostSwing(r, h, { who: 2, nailId: n.id, x: n.x, y: n.y });
    h.left.add(2);
    const m = createMirror(3, 0);
    applyHost(m, hostSnapshot(r, h, 0), 0);
    expect([...m.left]).toEqual([2]);
    expect(m.round.players[2]!.score).toBe(1);
  });

  it('the host applies only a well-formed blow from a guest seat', () => {
    const ok = { t: 'swing', who: 2, nailId: 4, x: 10, y: 20 };
    expect(readGuestMsg(ok, 3)).toEqual(ok);
    expect(readGuestMsg({ ...ok, nailId: null }, 3)).toEqual({ ...ok, nailId: null });
    expect(readGuestMsg({ ...ok, who: 0 }, 3)).toBeNull();
    expect(readGuestMsg({ ...ok, who: 3 }, 3)).toBeNull();
    expect(readGuestMsg({ ...ok, nailId: '4' }, 3)).toBeNull();
    expect(readGuestMsg({ ...ok, x: Number.NaN }, 3)).toBeNull();
    expect(readGuestMsg({ ...ok, t: 'start' }, 3)).toBeNull();
  });
});
