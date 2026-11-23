// «Гвіздки» with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md, decision 2): what the
// host's window and the guests' windows tell each other over the room's channel. The host runs
// the one real Round (lib/nail-game.ts) and judges every blow in the order it arrives; a guest
// keeps a mirror of it, fed by the host's batches of what changed and its periodic snapshots.
// Pure: the overlay owns the channel (stores/lounge.ts) and the clock.
import {
  FRAME_CLAMP_MS,
  LINGER_MS,
  ROUND_MS,
  hitNail,
  isOver,
  swingMiss,
  type Field,
  type Nail,
  type PlayerTally,
  type Round,
} from './nail-game';

/** The host included. */
export const LOUNGE_MAX_PLAYERS = 6;
/** A room's board in logical px, the same on every window and scaled to fit each (decision 3). */
export const ROOM_FIELD: Readonly<Field> = Object.freeze({ width: 1280, height: 720, top: 76, pad: 24 });
/** The host sends what changed at most this often… */
export const BATCH_MS = 50;
/** …and the whole board this often, so a lost batch is mended. */
export const SNAPSHOT_MS = 500;
/** A guest that hears nothing from the host for this long shows the round as paused. */
export const HOST_SILENT_MS = 1500;
/** The broadcast event the game's messages ride; another game would use its own. */
export const NAILS_EVENT = 'nails';

/** One player of a round, in seat order: seat 0 is the host. */
export type Seat = { clientId: string; userId: string; name: string; avatarUrl: string | null };

/** A blow someone struck, for the other windows' hammers and knocks. In field px. */
export type Swing = { who: number; x: number; y: number; hit: boolean; drove: boolean };

type RoundState = {
  seq: number;
  now: number;
  players: PlayerTally[];
  /** Seats whose window left during the round; their score stays. */
  left: number[];
  paused: boolean;
};

export type HostMsg =
  | { t: 'start'; seats: Seat[] }
  | (RoundState & { t: 'batch'; nails: Nail[]; swings: Swing[] })
  | (RoundState & { t: 'snap' | 'end'; nails: Nail[] })
  | { t: 'cancel' };

export type GuestMsg = { t: 'swing'; who: number; nailId: number | null; x: number; y: number };

// ── the host ────────────────────────────────────────────────────────────────

export type Host = {
  seq: number;
  /** Wall-clock ms of the last batch and the last snapshot. */
  batchAt: number;
  snapAt: number;
  /** Each nail as the guests last heard it, to send only what changed. */
  known: Map<number, string>;
  swings: Swing[];
  left: Set<number>;
  paused: boolean;
};

export function createHost(): Host {
  return { seq: 0, batchAt: -Infinity, snapAt: -Infinity, known: new Map(), swings: [], left: new Set(), paused: false };
}

const nailKey = (n: Nail): string => `${n.hits}|${n.expiresAt}|${n.doneAt}|${n.escapedAt}`;

/**
 * A blow by seat `who` — the host's own or a guest's — judged on the host's board as it is now:
 * a nail gone or driven by then makes it a miss, so the first blow to arrive takes a contested
 * nail.
 */
export function hostSwing(r: Round, h: Host, s: Omit<GuestMsg, 't'>): { hit: boolean; points: number } {
  if (isOver(r)) return { hit: false, points: 0 };
  const p = r.players[s.who]!;
  const hitsBefore = p.hits;
  const points = s.nailId === null ? (swingMiss(r, s.who), 0) : hitNail(r, s.nailId, s.who);
  const hit = p.hits > hitsBefore;
  h.swings.push({ who: s.who, x: s.x, y: s.y, hit, drove: points > 0 });
  return { hit, points };
}

function state(r: Round, h: Host): RoundState {
  h.seq += 1;
  return {
    seq: h.seq,
    now: r.now,
    players: r.players.map((p) => ({ ...p })),
    left: [...h.left],
    paused: h.paused,
  };
}

/** The whole board: every SNAPSHOT_MS, on a pause and at the end. Pending swings wait for the next batch. */
export function hostSnapshot(r: Round, h: Host, wallMs: number, t: 'snap' | 'end' = 'snap'): HostMsg {
  h.snapAt = wallMs;
  h.known = new Map(r.nails.map((n) => [n.id, nailKey(n)]));
  return { ...state(r, h), t, nails: r.nails.map((n) => ({ ...n })) };
}

/** What the host sends this frame, if anything: a snapshot when one is due, else what changed. */
export function hostOutgoing(r: Round, h: Host, wallMs: number): HostMsg[] {
  const out: HostMsg[] = [];
  if (wallMs - h.batchAt >= BATCH_MS) {
    const changed = r.nails.filter((n) => h.known.get(n.id) !== nailKey(n));
    if (changed.length || h.swings.length) {
      for (const n of changed) h.known.set(n.id, nailKey(n));
      for (const id of h.known.keys()) if (!r.nails.some((n) => n.id === id)) h.known.delete(id);
      out.push({ ...state(r, h), t: 'batch', nails: changed.map((n) => ({ ...n })), swings: h.swings });
      h.swings = [];
      h.batchAt = wallMs;
    }
  }
  if (wallMs - h.snapAt >= SNAPSHOT_MS) out.push(hostSnapshot(r, h, wallMs));
  return out;
}

/** A guest's message as the host may apply it; anything else (a wrong seat, a malformed field) is null. */
export function readGuestMsg(raw: Record<string, unknown>, seats: number): GuestMsg | null {
  const { t, who, nailId, x, y } = raw;
  if (t !== 'swing') return null;
  if (typeof who !== 'number' || !Number.isInteger(who) || who < 1 || who >= seats) return null;
  if (nailId !== null && (typeof nailId !== 'number' || !Number.isInteger(nailId))) return null;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { t, who, nailId, x, y };
}

// ── a guest ─────────────────────────────────────────────────────────────────

/**
 * A host's message in the shape a guest applies, or null. The host is a member of the workspace
 * and nothing is stored, so this guards the guest's window against a malformed message, not
 * against a forged one (decision 8).
 */
export function readHostMsg(raw: Record<string, unknown>): HostMsg | null {
  switch (raw.t) {
    case 'start':
      return Array.isArray(raw.seats) ? (raw as unknown as HostMsg) : null;
    case 'cancel':
      return { t: 'cancel' };
    case 'batch':
    case 'snap':
    case 'end': {
      const ok =
        typeof raw.seq === 'number' &&
        typeof raw.now === 'number' &&
        typeof raw.paused === 'boolean' &&
        Array.isArray(raw.players) &&
        Array.isArray(raw.nails) &&
        Array.isArray(raw.left) &&
        (raw.t !== 'batch' || Array.isArray(raw.swings));
      return ok ? (raw as unknown as HostMsg) : null;
    }
    default:
      return null;
  }
}

export type Mirror = {
  round: Round;
  seq: number;
  /** Wall-clock ms of the host's last message. */
  heardAt: number;
  left: Set<number>;
  paused: boolean;
  ended: boolean;
};

/** An empty board for `players` seats: the host's first snapshot fills it. It never spawns. */
export function createMirror(players: number, wallMs: number): Mirror {
  return {
    round: {
      now: 0,
      nails: [],
      players: Array.from({ length: players }, () => ({ score: 0, hits: 0, swings: 0, driven: 0 })),
      nextId: 1,
      nextSpawnAt: Infinity,
      field: { ...ROOM_FIELD },
      rng: Math.random,
    },
    seq: 0,
    heardAt: wallMs,
    left: new Set(),
    paused: false,
    ended: false,
  };
}

/**
 * Take in one of the host's round messages. One older than the last applied is dropped. Returns
 * the swings it carried, for the hammers and the knocks.
 */
export function applyHost(m: Mirror, msg: HostMsg, wallMs: number): Swing[] {
  if (msg.t === 'start' || msg.t === 'cancel' || msg.seq <= m.seq) return [];
  const r = m.round;
  m.seq = msg.seq;
  m.heardAt = wallMs;
  m.paused = msg.paused;
  m.left = new Set(msg.left);
  r.now = msg.now;
  r.players = msg.players.map((p) => ({ ...p }));
  if (msg.t === 'batch') {
    for (const n of msg.nails) {
      const i = r.nails.findIndex((x) => x.id === n.id);
      if (i >= 0) r.nails[i] = { ...n };
      else r.nails.push({ ...n });
    }
    return msg.swings;
  }
  r.nails = msg.nails.map((n) => ({ ...n }));
  if (msg.t === 'end') m.ended = true;
  return [];
}

export const hostSilent = (m: Mirror, wallMs: number): boolean => wallMs - m.heardAt >= HOST_SILENT_MS;

/**
 * Run the mirror's clock between the host's messages, so the board does not stutter at 20 Hz.
 * Nails never escape here — the host says when — but an escaped one leaves after its animation.
 * A paused or silent host stops it.
 */
export function tickMirror(m: Mirror, dtMs: number, wallMs: number): void {
  if (m.paused || m.ended || hostSilent(m, wallMs)) return;
  const r = m.round;
  r.now = Math.min(ROUND_MS, r.now + Math.max(0, Math.min(dtMs, FRAME_CLAMP_MS)));
  r.nails = r.nails.filter((n) => n.escapedAt === null || r.now - n.escapedAt < LINGER_MS);
}
