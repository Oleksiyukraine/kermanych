import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { NailGameTooSoonError, nailGameLeaderboard, submitNailGameScore } from "../src/nail-game";

type Err = { message: string } | null;

function fakeClient(opts: { insertError?: Err; rpcData?: unknown[] } = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: opts.insertError ?? null });
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: opts.rpcData ?? [], error: null });
    },
  } as unknown as SupabaseClient;
  return { client, inserts, rpcs };
}

describe("submitNailGameScore", () => {
  it("turns the trigger's refusal into NailGameTooSoonError", async () => {
    const fake = fakeClient({ insertError: { message: "nail_game_too_soon" } });
    await expect(submitNailGameScore(fake.client, 12)).rejects.toBeInstanceOf(NailGameTooSoonError);
  });

  it("refuses a score the table would refuse, before sending it", async () => {
    const fake = fakeClient();
    await expect(submitNailGameScore(fake.client, 401)).rejects.toThrow("out of range");
    await expect(submitNailGameScore(fake.client, 1.5)).rejects.toThrow("out of range");
    expect(fake.inserts).toEqual([]);
  });
});

describe("nailGameLeaderboard", () => {
  it("ranks everyone without a workspace and maps the rows", async () => {
    const fake = fakeClient({
      rpcData: [
        {
          place: 1,
          user_id: "u1",
          github_username: "octo",
          display_name: "Octo Cat",
          avatar_url: null,
          best_score: 42,
          achieved_at: "2026-11-18T10:00:00Z",
          players: 3,
        },
      ],
    });
    const rows = await nailGameLeaderboard(fake.client);
    expect(fake.rpcs).toEqual([{ fn: "nail_game_leaderboard", args: { p_workspace: null, p_limit: 10 } }]);
    expect(rows).toEqual([
      {
        place: 1,
        userId: "u1",
        githubUsername: "octo",
        displayName: "Octo Cat",
        avatarUrl: null,
        bestScore: 42,
        achievedAt: "2026-11-18T10:00:00Z",
        players: 3,
      },
    ]);
  });
});
