// «Гвіздки» with AI opponents (docs/specs/2026-11-19-nail-game-ai-opponents.md, decision 4):
// how one AI player's hammer plays the strikes its model planned. The model answers with a
// short list of nail ids (apps/api nail-game-prompt.ts); this module turns that list into
// hammer moves and strikes at a fixed hand speed, frame by frame, so every model plays with the
// same hands and the difference between them is how fast and how well they choose.
// Pure: the overlay owns the network and calls these.
import { NAIL_GAME_AI_STRIKE_MS, type NailGameBoard } from '@kermanych/core';
import { NAIL_W, headTop, hitNail, isStanding, type Round } from './nail-game';

/** Of each strike cycle, the hammer spends this long gliding to its target; the strike ends it. */
export const AI_GLIDE_MS = 110;
/** The lag the first board reports, before any round trip has been measured. */
export const AI_FIRST_LAG_MS = 1500;

export type AiSeat = {
  /** The player index in the round (1…). */
  who: number;
  model: string;
  /** Planned strikes not yet played, nail ids in order. */
  queue: number[];
  /** Where the hammer's striking face is, in field px. */
  pos: { x: number; y: number };
  from: { x: number; y: number };
  /** The nail the hammer is on its way to, and how long into the strike cycle it is. */
  target: number | null;
  cycleMs: number;
  /** Round time of its last strike: drives the swing animation. */
  struckAt: number | null;
  /** Whether a move is being asked for, and the last round trip. */
  asking: boolean;
  lagMs: number;
  moves: number;
  failures: number;
  /** Round time before which no new move is asked for (a pause after a failure). */
  askAfter: number;
  lastError: string | null;
  cost: number;
};

export function createSeat(who: number, model: string, start: { x: number; y: number }): AiSeat {
  return {
    who,
    model,
    queue: [],
    pos: { ...start },
    from: { ...start },
    target: null,
    cycleMs: 0,
    struckAt: null,
    asking: false,
    lagMs: AI_FIRST_LAG_MS,
    moves: 0,
    failures: 0,
    askAfter: 0,
    lastError: null,
    cost: 0,
  };
}

/** What this seat's model is shown: every standing nail, how much it still needs and how long it has. */
export function boardFor(r: Round, seat: AiSeat): NailGameBoard {
  const rival = Math.max(0, ...r.players.filter((_, i) => i !== seat.who).map((p) => p.score));
  return {
    t: Math.round(r.now),
    lagMs: Math.round(seat.lagMs),
    you: r.players[seat.who]!.score,
    rival,
    nails: r.nails.filter(isStanding).map((n) => ({
      id: n.id,
      kind: n.kind,
      strikes: n.needed - n.hits,
      ms: Math.max(0, Math.round(n.expiresAt - r.now)),
    })),
  };
}

/** A new plan replaces what is left of the old one: it was made from a fresher board. */
export function takePlan(seat: AiSeat, strikes: readonly number[]): void {
  seat.queue = [...strikes];
}

/**
 * Move the seat's hammer on by `dtMs`. Strikes that name a nail no longer standing are dropped
 * without a swing; a strike that lands goes through the round's own hitNail. Returns the points
 * a strike scored this frame, or null when it did not strike.
 */
export function stepSeat(r: Round, seat: AiSeat, dtMs: number): number | null {
  while (seat.queue.length) {
    const id = seat.queue[0]!;
    const n = r.nails.find((x) => x.id === id);
    if (!n || !isStanding(n)) {
      seat.queue.shift();
      continue;
    }
    if (seat.target !== id) {
      seat.target = id;
      seat.from = { ...seat.pos };
      seat.cycleMs = 0;
    }
    seat.cycleMs += dtMs;
    const aim = { x: n.x + NAIL_W / 2 + n.lean * 4, y: headTop(n) };
    const k = Math.min(1, seat.cycleMs / AI_GLIDE_MS);
    const ease = 1 - (1 - k) * (1 - k);
    seat.pos = { x: seat.from.x + (aim.x - seat.from.x) * ease, y: seat.from.y + (aim.y - seat.from.y) * ease };
    if (seat.cycleMs < NAIL_GAME_AI_STRIKE_MS) return null;
    // The next strike, on this nail or another, starts a fresh cycle from where the hammer is.
    seat.queue.shift();
    seat.target = null;
    seat.struckAt = r.now;
    return hitNail(r, id, seat.who);
  }
  seat.target = null;
  return null;
}
