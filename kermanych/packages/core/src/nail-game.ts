// «Гвіздки» with AI opponents (docs/specs/2026-11-19-nail-game-ai-opponents.md): the wire
// between the overlay, which runs the round, and the api, which asks a model for its next
// strikes. In core so the browser that builds the board and the api that validates it and
// prints it into the prompt agree on one shape and one set of limits.
import type { Usage } from "./types";

/** At most this many AI opponents share the board with the player (an arena of four). */
export const NAIL_GAME_MAX_OPPONENTS = 3;
/** An AI hammer strikes once per this, in the order the model gave (the prompt says so). */
export const NAIL_GAME_AI_STRIKE_MS = 180;
/** The most strikes one answer may plan; the rest of a longer answer is dropped. */
export const NAIL_GAME_AI_MAX_STRIKES = 6;
/** Every strike keeps a nail up this much longer (the round engine's rule; the prompt states it). */
export const NAIL_GAME_HIT_BONUS_MS = 600;
/** The most nails one board lists: the engine never has more than 7 standing. */
export const NAIL_GAME_BOARD_MAX_NAILS = 16;

/** One standing nail as the model sees it. */
export type NailGameBoardNail = {
  id: number;
  kind: "straight" | "bent";
  /** Strikes still needed to drive it in. */
  strikes: number;
  /** Ms before it hides again unless somebody strikes it. */
  ms: number;
};

/** The board at the moment the overlay asks one AI player for its move. */
export type NailGameBoard = {
  /** Round time elapsed, ms. */
  t: number;
  /** This player's last round trip, ms: how stale the board will be when the answer lands. */
  lagMs: number;
  /** This player's score, and the best score among the others (the human included). */
  you: number;
  rival: number;
  nails: NailGameBoardNail[];
};

export type NailGameMoveAsk = { model: string; board: NailGameBoard };

/** The strikes the model planned, in order (ids of nails on the board it was sent). */
export type NailGameMove = { strikes: number[]; ms: number; usage?: Usage };
