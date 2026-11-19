// «Гвіздки», the one-minute break game (docs/specs/2026-11-18-nail-hammer-minigame.md,
// decision 1; players and AI opponents: docs/specs/2026-11-19-nail-game-ai-opponents.md): the
// round's rules as a pure state machine. The overlay feeds it frame time and strikes and draws
// what it holds; nothing here touches the DOM, so the numbers are testable.
import { NAIL_GAME_HIT_BONUS_MS } from '@kermanych/core';

export const ROUND_MS = 60_000;
export const COUNTDOWN_MS = 3_000;
/** A frame longer than this (a hidden window, a stall) counts as this much: the round pauses. */
export const FRAME_CLAMP_MS = 100;
export const BENT_CHANCE = 0.25;
/** Every hit keeps the nail up this much longer, so it does not vanish under the hammer. */
export const HIT_BONUS_MS = NAIL_GAME_HIT_BONUS_MS;
/** An escaped nail stays this long for its animation, then leaves the list. */
export const LINGER_MS = 450;

/** The nail sprite's box in CSS px; the sprite is drawn into exactly this. */
export const NAIL_W = 56;
export const NAIL_H = 96;
/** Where the nail meets the ground, and how tall its shaft and head are, in the box. */
export const NAIL_GROUND = NAIL_H - 6;
export const NAIL_SHAFT = 58;
export const NAIL_HEAD_H = 15;
/** A swing this far outside the sprite's box still lands on the nail. */
export const HIT_PAD = 18;
/** Two standing nails' boxes keep at least this far apart (top-left to top-left). */
const MIN_GAP = 72;
const SPAWN_TRIES = 12;

// Start → end of the round, interpolated linearly over its 60 s.
const LIFETIME_MS: readonly [number, number] = [2600, 1700];
const MAX_ALIVE: readonly [number, number] = [3, 7];
export const SPAWN_EVERY_MS: readonly [number, number] = [800, 380];

export type NailKind = 'straight' | 'bent';

export type Nail = {
  id: number;
  kind: NailKind;
  /** Top-left of the sprite box, in field px. */
  x: number;
  y: number;
  /** A bent nail's lean: -1 (left) or 1 (right); 0 for a straight one. */
  lean: -1 | 0 | 1;
  hits: number;
  needed: number;
  points: number;
  expiresAt: number;
  lastHitAt: number | null;
  /** Driven all the way in; it stays on the board, flush, until the round ends. */
  doneAt: number | null;
  /** The player whose strike drove it in. */
  by: number | null;
  /** Gone unhit. */
  escapedAt: number | null;
};

/** One player's tally. Player 0 is the person at the keyboard; the rest are AI opponents. */
export type PlayerTally = {
  score: number;
  /** Swings that landed on a nail still standing. */
  hits: number;
  /** Every swing, missed or not. */
  swings: number;
  driven: number;
};

/** The area nails may appear in. `top` keeps them off the score bar. */
export type Field = { width: number; height: number; top: number; pad: number };

export type Round = {
  /** Play time elapsed, ms: 0…ROUND_MS. */
  now: number;
  nails: Nail[];
  players: PlayerTally[];
  nextId: number;
  nextSpawnAt: number;
  field: Field;
  rng: () => number;
};

const lerp = ([from, to]: readonly [number, number], p: number) => from + (to - from) * p;

export function createRound(field: Field, players = 1, rng: () => number = Math.random): Round {
  const round: Round = {
    now: 0,
    nails: [],
    players: Array.from({ length: players }, () => ({ score: 0, hits: 0, swings: 0, driven: 0 })),
    nextId: 1,
    nextSpawnAt: 0,
    field,
    rng,
  };
  spawnDue(round);
  return round;
}

export const isOver = (r: Round): boolean => r.now >= ROUND_MS;
export const isStanding = (n: Nail): boolean => n.doneAt === null && n.escapedAt === null;
export const timeLeftMs = (r: Round): number => Math.max(0, ROUND_MS - r.now);
/** Hits ÷ swings, 0…1; 0 before the first swing. */
export const accuracy = (p: PlayerTally): number => (p.swings ? p.hits / p.swings : 0);

/** The top of the nail's head in field px: where a hammer lands on it. Sinks with every hit. */
export function headTop(n: Nail): number {
  return n.y + NAIL_GROUND - NAIL_SHAFT * (1 - n.hits / n.needed) - NAIL_HEAD_H;
}

/** Move the round on by one frame's time: spawn what is due, let unhit nails escape. */
export function advance(r: Round, dtMs: number): void {
  if (isOver(r)) return;
  r.now = Math.min(ROUND_MS, r.now + Math.max(0, Math.min(dtMs, FRAME_CLAMP_MS)));
  for (const n of r.nails) {
    if (isStanding(n) && r.now >= n.expiresAt) n.escapedAt = r.now;
  }
  r.nails = r.nails.filter((n) => n.escapedAt === null || r.now - n.escapedAt < LINGER_MS);
  if (!isOver(r)) spawnDue(r);
}

/**
 * The standing nail a swing at (x, y) lands on: its box grown by HIT_PAD on every side, the
 * nearest one when two overlap. Null for a miss.
 */
export function nailAt(r: Round, x: number, y: number): Nail | null {
  let best: Nail | null = null;
  let bestD = Infinity;
  for (const n of r.nails) {
    if (!isStanding(n)) continue;
    if (x < n.x - HIT_PAD || x > n.x + NAIL_W + HIT_PAD || y < n.y - HIT_PAD || y > n.y + NAIL_H + HIT_PAD) continue;
    const d = Math.hypot(x - (n.x + NAIL_W / 2), y - (n.y + NAIL_H / 2));
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** Player `who`'s swing that landed on nail `id`. Returns the points it scored (0 unless it drove it in). */
export function hitNail(r: Round, id: number, who = 0): number {
  const n = r.nails.find((x) => x.id === id);
  if (isOver(r) || !n || !isStanding(n)) {
    swingMiss(r, who);
    return 0;
  }
  const p = r.players[who]!;
  p.swings += 1;
  p.hits += 1;
  n.hits += 1;
  n.lastHitAt = r.now;
  n.expiresAt += HIT_BONUS_MS;
  if (n.hits < n.needed) return 0;
  n.doneAt = r.now;
  n.by = who;
  p.score += n.points;
  p.driven += 1;
  return n.points;
}

/** Player `who`'s swing that hit nothing. */
export function swingMiss(r: Round, who = 0): void {
  if (!isOver(r)) r.players[who]!.swings += 1;
}

// One nail per due tick. The tick moves on even when no nail fits (the field is full or crowded):
// the spawn rate, not the free space, bounds how many nails a round can have — and so the score.
function spawnDue(r: Round): void {
  while (r.now >= r.nextSpawnAt) {
    const p = Math.min(1, r.now / ROUND_MS);
    r.nextSpawnAt += lerp(SPAWN_EVERY_MS, p);
    const standing = r.nails.filter(isStanding);
    if (standing.length >= Math.round(lerp(MAX_ALIVE, p))) continue;
    const spot = freeSpot(r, standing);
    if (!spot) continue;
    const bent = r.rng() < BENT_CHANCE;
    r.nails.push({
      id: r.nextId++,
      kind: bent ? 'bent' : 'straight',
      x: spot.x,
      y: spot.y,
      lean: bent ? (r.rng() < 0.5 ? -1 : 1) : 0,
      hits: 0,
      needed: bent ? 3 : 2,
      points: bent ? 2 : 1,
      expiresAt: r.now + lerp(LIFETIME_MS, p),
      lastHitAt: null,
      doneAt: null,
      by: null,
      escapedAt: null,
    });
  }
}

// Clear of every nail on the board when it can be — driven ones stay until the end, so a new
// nail should not pop out of one — and clear of the standing ones at least, once the board fills.
function freeSpot(r: Round, standing: Nail[]): { x: number; y: number } | null {
  const { width, height, top, pad } = r.field;
  const spanX = Math.max(0, width - 2 * pad - NAIL_W);
  const spanY = Math.max(0, height - top - pad - NAIL_H);
  const driven = r.nails.filter((n) => n.doneAt !== null);
  for (let i = 0; i < 2 * SPAWN_TRIES; i += 1) {
    const x = Math.round(pad + r.rng() * spanX);
    const y = Math.round(top + r.rng() * spanY);
    const clear = (n: Nail) => Math.hypot(n.x - x, n.y - y) >= MIN_GAP;
    if (standing.every(clear) && (i >= SPAWN_TRIES || driven.every(clear))) return { x, y };
  }
  return null;
}
