// apps/api/src/nail-game/nail-game-prompt.ts
// «Гвіздки» with AI opponents (docs/specs/2026-11-19-nail-game-ai-opponents.md, decisions 3–4):
// what one AI player is told and how its answer is read. Pure, so the contract the model plays
// under and the parser that turns its prose into strikes are tested without an omp child.
import {
  NAIL_GAME_AI_MAX_STRIKES,
  NAIL_GAME_AI_STRIKE_MS,
  NAIL_GAME_BOARD_MAX_NAILS,
  NAIL_GAME_HIT_BONUS_MS,
  type NailGameBoard,
  type NailGameBoardNail,
} from "@kermanych/core";

// Sent once, with the first board of a round: the child keeps it for the rest of the round
// (one child per player per round, dropped at its end), so every later turn is the board only.
const CONTRACT = [
  "You are an AI player in «Гвіздки» (Nails), a one-minute whack-a-nail race. You share one board with a human and maybe other AI models; whoever scores more wins.",
  "",
  "Rules:",
  `- Nails pop up and hide again unless they are finished in time. Every strike on a nail, by anyone, keeps it up ${NAIL_GAME_HIT_BONUS_MS} ms longer.`,
  "- A straight nail needs 2 strikes and scores 1; a bent one needs 3 strikes and scores 2.",
  "- The points go to the player whose strike drives the nail all the way in, so a nail a rival has started is still up for grabs.",
  "",
  "Each message is the board when it was taken: a header line, then one nail per line as `id kind strikes_left ms_left`.",
  `Your answer reaches the board about \`lag\` ms after that. Your hammer then strikes once every ${NAIL_GAME_AI_STRIKE_MS} ms, in your order; a nail that is gone or already driven by then is skipped.`,
  "",
  `Answer with nail ids only, separated by spaces, one id per strike, at most ${NAIL_GAME_AI_MAX_STRIKES} strikes — for example \`14 14 9 9 9\`. No other text.`,
].join("\n");

export function buildNailGameTurn(p: { first: boolean; board: NailGameBoard }): string {
  const b = p.board;
  const head = `t=${(b.t / 1000).toFixed(1)}s lag=${b.lagMs}ms you=${b.you} best_rival=${b.rival}`;
  const lines = b.nails.map((n) => `${n.id} ${n.kind} ${n.strikes} ${n.ms}`);
  const board = [head, ...(lines.length ? lines : ["(no nails)"])].join("\n");
  return p.first ? `${CONTRACT}\n\n${board}` : board;
}

// The ids in the answer, in order, that name a nail on the board it was sent. Anything else —
// a word the model added despite the contract, an id it invented — is dropped rather than
// failing the turn: a half-usable answer still plays, and a wrong one only costs its player.
export function parseStrikes(raw: string, board: NailGameBoard): number[] {
  const ids = new Set(board.nails.map((n) => n.id));
  const out: number[] = [];
  for (const m of raw.matchAll(/\d+/g)) {
    const id = Number(m[0]);
    if (!ids.has(id)) continue;
    out.push(id);
    if (out.length === NAIL_GAME_AI_MAX_STRIKES) break;
  }
  return out;
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

// The board as it arrives over HTTP, rebuilt field by field: every value is printed into the
// prompt, so nothing the browser sent goes there unchecked. Null when anything is off.
export function readNailGameBoard(raw: unknown): NailGameBoard | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const t = int(b.t, 0, 120_000);
  const lagMs = int(b.lagMs, 0, 120_000);
  const you = int(b.you, 0, 1000);
  const rival = int(b.rival, 0, 1000);
  if (t === null || lagMs === null || you === null || rival === null) return null;
  if (!Array.isArray(b.nails) || b.nails.length > NAIL_GAME_BOARD_MAX_NAILS) return null;
  const nails: NailGameBoardNail[] = [];
  for (const x of b.nails as unknown[]) {
    const n = (x ?? {}) as Record<string, unknown>;
    const id = int(n.id, 1, 1_000_000);
    const strikes = int(n.strikes, 1, 3);
    const ms = int(n.ms, 0, 60_000);
    if (id === null || strikes === null || ms === null) return null;
    if (n.kind !== "straight" && n.kind !== "bent") return null;
    nails.push({ id, kind: n.kind, strikes, ms });
  }
  return { t, lagMs, you, rival, nails };
}
