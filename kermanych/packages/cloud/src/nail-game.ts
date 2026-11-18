// «Гвіздки», the one-minute break game (docs/specs/2026-11-18-nail-hammer-minigame.md): one
// insert-only `nail_game_scores` row per finished round, and the leaderboard through the
// `nail_game_leaderboard` function (supabase/migrations/20261118090000_nail_game.sql).
import type { SupabaseClient } from "@supabase/supabase-js";

/** The table's check: perfect play stays below it (apps/ui/src/lib/nail-game.ts). */
export const NAIL_GAME_MAX_SCORE = 400;

export type NailGameLeaderRow = {
  /** 1-based; players with the same best score share it. */
  place: number;
  userId: string;
  githubUsername: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bestScore: number;
  achievedAt: string;
  /** How many players the scope ranks. */
  players: number;
};

/** The trigger refused a second score within 50 seconds of the last one. */
export class NailGameTooSoonError extends Error {
  constructor() {
    super("nail_game_too_soon");
    this.name = "NailGameTooSoonError";
  }
}

/** Record one finished round for the signed-in user. */
export async function submitNailGameScore(client: SupabaseClient, score: number): Promise<void> {
  if (!Number.isInteger(score) || score < 0 || score > NAIL_GAME_MAX_SCORE) {
    throw new Error(`nail game score out of range: ${score}`);
  }
  // No `.select()`: the player has no SELECT on the table.
  const { error } = await client.from("nail_game_scores").insert({ score });
  if (error) {
    if (error.message.includes("nail_game_too_soon")) throw new NailGameTooSoonError();
    throw new Error(error.message);
  }
}

type LeaderRowDb = {
  place: number;
  user_id: string;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  best_score: number;
  achieved_at: string;
  players: number;
};

/**
 * Each player's best score, best first: the top `limit` and the caller's own row when it is
 * outside them. `workspaceId` ranks only that workspace's members (nothing for an outsider);
 * without it, everyone.
 */
export async function nailGameLeaderboard(
  client: SupabaseClient,
  opts: { workspaceId?: string | undefined; limit?: number | undefined } = {},
): Promise<NailGameLeaderRow[]> {
  const { data, error } = await client.rpc("nail_game_leaderboard", {
    p_workspace: opts.workspaceId ?? null,
    p_limit: opts.limit ?? 10,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as LeaderRowDb[]).map((r) => ({
    place: r.place,
    userId: r.user_id,
    githubUsername: r.github_username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    bestScore: r.best_score,
    achievedAt: r.achieved_at,
    players: r.players,
  }));
}
