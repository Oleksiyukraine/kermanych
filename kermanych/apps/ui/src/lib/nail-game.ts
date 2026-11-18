// «Гвіздки», the one-minute break game (docs/specs/2026-11-18-nail-hammer-minigame.md,
// decision 1): the round's rules as a pure state machine. The overlay feeds it frame time and
// clicks and draws what it holds; nothing here touches the DOM, so the numbers are testable.

export const ROUND_MS = 60_000;
export const COUNTDOWN_MS = 3_000;
/** A frame longer than this (a hidden window, a stall) counts as this much: the round pauses. */
export const FRAME_CLAMP_MS = 100;
export const BENT_CHANCE = 0.25;
/** Every hit keeps the nail up this much longer, so it does not vanish under the hammer. */
export const HIT_BONUS_MS = 600;
/** A driven or escaped nail stays this long for its animation, then leaves the list. */
export const LINGER_MS = 450;

/** The nail sprite's box in CSS px; the sprite is drawn into exactly this. */
export const NAIL_W = 56;
export const NAIL_H = 96;
/** Two nails' boxes keep at least this far apart (top-left to top-left). */
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
  /** Driven all the way in. */
  doneAt: number | null;
  /** Gone unhit. */
  escapedAt: number | null;
};

/** The area nails may appear in. `top` keeps them off the score bar. */
export type Field = { width: number; height: number; top: number; pad: number };

export type Round = {
  /** Play time elapsed, ms: 0…ROUND_MS. */
  now: number;
  nails: Nail[];
  score: number;
  /** Swings that landed on a nail still standing. */
  hits: number;
  /** Every swing, missed or not. */
  swings: number;
  driven: number;
  nextId: number;
  nextSpawnAt: number;
  field: Field;
  rng: () => number;
};

const lerp = ([from, to]: readonly [number, number], p: number) => from + (to - from) * p;

export function createRound(field: Field, rng: () => number = Math.random): Round {
  const round: Round = {
    now: 0,
    nails: [],
    score: 0,
    hits: 0,
    swings: 0,
    driven: 0,
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
export const accuracy = (r: Round): number => (r.swings ? r.hits / r.swings : 0);

/** Move the round on by one frame's time: spawn what is due, let unhit nails escape. */
export function advance(r: Round, dtMs: number): void {
  if (isOver(r)) return;
  r.now = Math.min(ROUND_MS, r.now + Math.max(0, Math.min(dtMs, FRAME_CLAMP_MS)));
  for (const n of r.nails) {
    if (isStanding(n) && r.now >= n.expiresAt) n.escapedAt = r.now;
  }
  r.nails = r.nails.filter((n) => {
    const gone = n.doneAt ?? n.escapedAt;
    return gone === null || r.now - gone < LINGER_MS;
  });
  if (!isOver(r)) spawnDue(r);
}

/** A swing that landed on nail `id`. Returns the points it scored (0 unless it drove it in). */
export function hitNail(r: Round, id: number): number {
  const n = r.nails.find((x) => x.id === id);
  if (isOver(r) || !n || !isStanding(n)) {
    swingMiss(r);
    return 0;
  }
  r.swings += 1;
  r.hits += 1;
  n.hits += 1;
  n.lastHitAt = r.now;
  n.expiresAt += HIT_BONUS_MS;
  if (n.hits < n.needed) return 0;
  n.doneAt = r.now;
  r.score += n.points;
  r.driven += 1;
  return n.points;
}

/** A swing that hit nothing. */
export function swingMiss(r: Round): void {
  if (!isOver(r)) r.swings += 1;
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
      escapedAt: null,
    });
  }
}

function freeSpot(r: Round, standing: Nail[]): { x: number; y: number } | null {
  const { width, height, top, pad } = r.field;
  const spanX = Math.max(0, width - 2 * pad - NAIL_W);
  const spanY = Math.max(0, height - top - pad - NAIL_H);
  for (let i = 0; i < SPAWN_TRIES; i += 1) {
    const x = Math.round(pad + r.rng() * spanX);
    const y = Math.round(top + r.rng() * spanY);
    if (standing.every((n) => Math.hypot(n.x - x, n.y - y) >= MIN_GAP)) return { x, y };
  }
  return null;
}
